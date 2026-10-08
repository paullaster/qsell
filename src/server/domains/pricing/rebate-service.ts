import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  rebateAccruals,
  rebateBalances,
  rebatePrograms,
  type RebateProgramRow,
} from '@/server/db/drizzle/schema';
import type { Tx } from '@/server/kernel/approvals/engine';
import { targetMatches } from './domain/discounts';
import { periodKey } from './domain/rebate';
import { scopeMismatch } from './domain/resolve';
import type { PriceGuardService } from './guard-service';
import type { PricingService } from './service';

const TTL_MS = 15_000;

/** What a sale earns towards a rebate: the net purchases of one product, tax left out. */
export interface RebateLine {
  productId: string;
  net: number;
}

export interface RebateSale {
  companyId: string;
  customerId: string | null;
  branchId?: string | null;
  at?: Date;
}

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Keeps each customer's running total for every rebate programme. An order adds what it is worth
 * in the same transaction that saves it; cancelling or crediting it takes the amount back with a
 * later entry. The accruals are the record, the balance row is their sum.
 */
export class RebateService {
  private cache = new Map<string, { at: number; value: RebateProgramRow[] }>();

  constructor(
    private readonly db: DrizzleDb,
    private readonly guard: PriceGuardService,
    private readonly pricing: PricingService,
  ) {}

  invalidate(companyId?: string) {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  async activePrograms(companyId: string): Promise<RebateProgramRow[]> {
    const hit = this.cache.get(companyId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const rows = await this.db
      .select()
      .from(rebatePrograms)
      .where(and(eq(rebatePrograms.companyId, companyId), eq(rebatePrograms.status, 'active')));
    this.cache.set(companyId, { at: Date.now(), value: rows });
    return rows;
  }

  /** How much of the sale counts towards each programme the customer is in. */
  async basisFor(
    sale: RebateSale,
    lines: RebateLine[],
    programs?: RebateProgramRow[],
  ): Promise<Array<{ program: RebateProgramRow; basis: number }>> {
    if (!sale.customerId || lines.length === 0) return [];
    const at = sale.at ?? new Date();
    const live = (programs ?? (await this.activePrograms(sale.companyId))).filter(
      (p) => at >= p.validFrom && (p.validTo == null || at < p.validTo),
    );
    if (live.length === 0) return [];
    const [facts, groupId] = await Promise.all([
      this.guard.floorProducts(
        sale.companyId,
        lines.map((l) => l.productId),
      ),
      this.pricing.groupFor(sale.companyId, sale.customerId),
    ]);
    const ctx = {
      at,
      currency: '',
      baseCurrency: '',
      rateFromBase: 1,
      decimals: 2,
      customerId: sale.customerId,
      customerGroupId: groupId,
      branchId: sale.branchId ?? null,
    };
    const out: Array<{ program: RebateProgramRow; basis: number }> = [];
    for (const program of live) {
      if (scopeMismatch(program.scopes, ctx)) continue;
      let basis = 0;
      for (const l of lines) {
        const p = facts.get(l.productId);
        const match = targetMatches(program.target, {
          id: l.productId,
          brand: p?.brand ?? null,
          categoryChain: p?.categoryChain ?? [],
          groupIds: p?.groupIds ?? [],
        });
        if (match) basis += l.net;
      }
      basis = money(basis);
      if (basis !== 0) out.push({ program, basis });
    }
    return out;
  }

  /** Counts a new order. Safe to call twice for the same order. */
  async accrueOrder(tx: Tx, sale: RebateSale, orderId: string, lines: RebateLine[]): Promise<void> {
    const hits = (await this.basisFor(sale, lines)).filter((h) => h.basis > 0);
    for (const { program, basis } of hits)
      await this.add(tx, {
        companyId: sale.companyId,
        program,
        customerId: sale.customerId!,
        period: periodKey(sale.at ?? new Date(), program.period),
        sourceType: 'order',
        sourceId: orderId,
        basis,
      });
  }

  /** Takes a cancelled order's accruals back, once. */
  async reverseOrder(tx: Tx, orderId: string): Promise<void> {
    const rows = await tx
      .select()
      .from(rebateAccruals)
      .where(and(eq(rebateAccruals.sourceId, orderId), eq(rebateAccruals.sourceType, 'order')));
    if (rows.length === 0) return;
    const done = await tx
      .select({ programId: rebateAccruals.programId })
      .from(rebateAccruals)
      .where(
        and(eq(rebateAccruals.sourceId, orderId), eq(rebateAccruals.sourceType, 'order_cancel')),
      );
    const reversed = new Set(done.map((d) => d.programId));
    for (const r of rows) {
      if (reversed.has(r.programId)) continue;
      await this.add(tx, {
        companyId: r.companyId,
        programId: r.programId,
        programVersion: r.programVersion,
        customerId: r.customerId,
        period: r.periodKey,
        sourceType: 'order_cancel',
        sourceId: orderId,
        basis: -Number(r.basisAmount),
      });
    }
  }

  /**
   * Takes back what a credit note returned. It lands in the period of the original sale, for the
   * programmes that counted that sale, and only for the products the programme covers.
   */
  async accrueCredit(
    tx: Tx,
    input: { companyId: string; orderId: string; creditNoteId: string },
    lines: RebateLine[],
  ): Promise<void> {
    const originals = await tx
      .select()
      .from(rebateAccruals)
      .where(
        and(eq(rebateAccruals.sourceId, input.orderId), eq(rebateAccruals.sourceType, 'order')),
      );
    if (originals.length === 0 || lines.length === 0) return;
    const programs = await tx
      .select()
      .from(rebatePrograms)
      .where(
        inArray(
          rebatePrograms.id,
          originals.map((o) => o.programId),
        ),
      );
    const byId = new Map(programs.map((p) => [p.id, p]));
    const facts = await this.guard.floorProducts(
      input.companyId,
      lines.map((l) => l.productId),
    );
    for (const o of originals) {
      const program = byId.get(o.programId);
      if (!program) continue;
      let back = 0;
      for (const l of lines) {
        const p = facts.get(l.productId);
        if (
          targetMatches(program.target, {
            id: l.productId,
            brand: p?.brand ?? null,
            categoryChain: p?.categoryChain ?? [],
            groupIds: p?.groupIds ?? [],
          })
        )
          back += l.net;
      }
      // Never take back more than the order counted for this programme, across all its credits.
      const [credited] = await tx
        .select({ total: sql<string>`coalesce(sum(${rebateAccruals.basisAmount}), 0)` })
        .from(rebateAccruals)
        .where(
          and(
            eq(rebateAccruals.programId, o.programId),
            eq(rebateAccruals.sourceType, 'credit_note'),
            sql`starts_with(${rebateAccruals.sourceId}, ${`${input.orderId}:`})`,
          ),
        );
      back = Math.min(money(back), money(Number(o.basisAmount) + Number(credited?.total ?? 0)));
      if (back <= 0) continue;
      await this.add(tx, {
        companyId: input.companyId,
        program,
        customerId: o.customerId,
        period: o.periodKey,
        sourceType: 'credit_note',
        // Keyed by order first, so an order's credits can be added up.
        sourceId: `${input.orderId}:${input.creditNoteId}`,
        basis: -back,
      });
    }
  }

  private async add(
    tx: Tx,
    a: {
      companyId: string;
      customerId: string;
      period: string;
      sourceType: 'order' | 'order_cancel' | 'credit_note';
      sourceId: string;
      basis: number;
    } & (
      | { program: RebateProgramRow; programId?: undefined; programVersion?: undefined }
      | { program?: undefined; programId: string; programVersion: number }
    ),
  ) {
    const programId = a.program?.id ?? a.programId!;
    const inserted = await tx
      .insert(rebateAccruals)
      .values({
        companyId: a.companyId,
        programId,
        customerId: a.customerId,
        periodKey: a.period,
        sourceType: a.sourceType,
        sourceId: a.sourceId,
        basisAmount: a.basis.toFixed(2),
        programVersion: a.program?.version ?? a.programVersion!,
      })
      .onConflictDoNothing()
      .returning({ id: rebateAccruals.id });
    // Already counted: the balance has it.
    if (inserted.length === 0) return;
    await tx
      .insert(rebateBalances)
      .values({
        programId,
        customerId: a.customerId,
        periodKey: a.period,
        basis: a.basis.toFixed(2),
      })
      .onConflictDoUpdate({
        target: [rebateBalances.programId, rebateBalances.customerId, rebateBalances.periodKey],
        set: {
          basis: sql`${rebateBalances.basis} + ${a.basis.toFixed(2)}::numeric`,
          updatedAt: new Date(),
        },
      });
  }
}
