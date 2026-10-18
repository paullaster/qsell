import { and, desc, eq, sql } from 'drizzle-orm';
import { has, orElse, required, trimToNull } from '@/lib/values';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  customers,
  financeSettings,
  orders,
  loyaltyAccounts,
  loyaltyLedger,
  loyaltyPrograms,
  type LoyaltyProgramRow,
} from '@/server/db/drizzle/schema';
import type { Tx } from '@/server/kernel/approvals/engine';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import type { FxService } from '@/server/domains/finance/fx-service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { PricingConfigError } from './config-service';
import {
  checkLoyalty,
  pointsEarned,
  redemption,
  summariseLoyalty,
  tierFor,
  type LoyaltyConfig,
  type LoyaltyTier,
} from './domain/loyalty';

type Why = ReasonInput;
const TTL_MS = 15_000;

export const toConfig = (r: LoyaltyProgramRow): LoyaltyConfig => ({
  pointsPer100: Number(r.pointsPer100),
  pointValue: Number(r.pointValue),
  minRedeemPoints: r.minRedeemPoints,
  maxRedeemPercent: Number(r.maxRedeemPercent),
  expiryMonths: r.expiryMonths,
  tiers: r.tiers,
});

export interface LoyaltyProgramView {
  name: string;
  status: 'active' | 'paused';
  version: number;
  config: LoyaltyConfig;
  summary: string;
}

export interface LoyaltyAccountView {
  customerId: string;
  customerName: string;
  balance: number;
  lifetimeEarned: number;
  tier: LoyaltyTier | null;
  /** What the balance is worth when spent, 0 when there is no programme in force. */
  worth: number;
  ledger: {
    id: string;
    kind: string;
    points: number;
    orderId: string | null;
    note: string | null;
    expiresAt: string | null;
    createdAt: string;
  }[];
}

/**
 * Loyalty points. Earning and spending happen inside the order's own transaction; the ledger is the
 * record and the account row is its running total, so a customer's balance never needs summing.
 * Nothing here changes a price: spending points is a payment, applied to an order afterwards.
 */
export class LoyaltyService {
  private readonly cache = new Map<string, { at: number; value: LoyaltyProgramRow | null }>();

  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly fx: FxService,
  ) {}

  invalidate(companyId?: string) {
    if (has(companyId)) this.cache.delete(companyId);
    else this.cache.clear();
  }

  private async programRow(companyId: string): Promise<LoyaltyProgramRow | null> {
    const hit = this.cache.get(companyId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const [row] = await this.db
      .select()
      .from(loyaltyPrograms)
      .where(eq(loyaltyPrograms.companyId, companyId))
      .limit(1);
    this.cache.set(companyId, { at: Date.now(), value: row ?? null });
    return row ?? null;
  }

  /** The rules, only while the programme is in force. */
  async activeConfig(companyId: string): Promise<LoyaltyConfig | null> {
    const row = await this.programRow(companyId);
    return row?.status === 'active' ? toConfig(row) : null;
  }

  async program(companyId: string): Promise<LoyaltyProgramView | null> {
    const row = await this.programRow(companyId);
    if (!row) return null;
    const config = toConfig(row);
    return {
      name: row.name,
      status: row.status,
      version: row.version,
      config,
      summary: summariseLoyalty(config),
    };
  }

  async saveProgram(
    companyId: string,
    input: { name: string; status: 'active' | 'paused'; config: LoyaltyConfig },
    actor: Actor,
    reason: Why,
  ): Promise<LoyaltyProgramView> {
    const why = await this.reasons.require(companyId, reason, 'pricing_configuration');
    const checks = checkLoyalty(input.config);
    const firstError = checks.errors[0];
    if (firstError !== undefined)
      throw new PricingConfigError('INVALID', firstError.message, checks.errors);
    const before = await this.programRow(companyId);
    const c = input.config;
    const values = {
      name: orElse(input.name.trim(), 'Loyalty'),
      status: input.status,
      pointsPer100: String(c.pointsPer100),
      pointValue: String(c.pointValue),
      minRedeemPoints: c.minRedeemPoints,
      maxRedeemPercent: String(c.maxRedeemPercent),
      expiryMonths: c.expiryMonths,
      tiers: [...c.tiers].sort((a, b) => a.fromPoints - b.fromPoints),
      updatedAt: new Date(),
    };
    await this.db.transaction(async (tx) => {
      const [row] = before
        ? await tx
            .update(loyaltyPrograms)
            .set({ ...values, version: before.version + 1 })
            .where(eq(loyaltyPrograms.companyId, companyId))
            .returning()
        : await tx
            .insert(loyaltyPrograms)
            .values({ companyId, ...values })
            .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'loyalty_program', id: required(row, 'the programme row').id },
          action: before ? 'pricing.loyalty_updated' : 'pricing.loyalty_created',
          reason: why,
          from: before?.status ?? null,
          to: input.status,
          inputs: before ? { ...toConfig(before) } : undefined,
          outcome: { ...c },
        },
        tx,
      );
    });
    this.invalidate(companyId);
    return required(await this.program(companyId), 'the programme just saved');
  }

  /**
   * What one unit of the order's currency is worth in the books' currency today. Points are worth money in the books' currency,
   * so an order in another currency is converted at the day's rate. Null when that currency has no rate yet.
   */
  private async baseRate(tx: Tx, companyId: string, currency: string | undefined): Promise<string | null> {
    if (currency === undefined) return '1';
    const [books] = await tx.select({ base: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (books === undefined || currency.toUpperCase() === books.base.toUpperCase()) return '1';
    return await this.fx.rateOn(tx, companyId, currency, businessDate());
  }

  // ── Earning and spending, inside an order's transaction ─────────────────

  /** Gives points for an order. Safe to call twice: an order earns once. */
  async earnOrder(
    tx: Tx,
    input: { companyId: string; customerId: string; orderId: string; spend: number; at?: Date },
  ): Promise<number> {
    const cfg = await this.activeConfig(input.companyId);
    if (!cfg || !(input.spend > 0)) return 0;
    // Points are earned on what was spent in the books' currency; an order in another currency with no rate yet earns none.
    const [placed] = await tx.select({ currency: orders.currency }).from(orders).where(eq(orders.id, input.orderId));
    const rate = await this.baseRate(tx, input.companyId, placed?.currency);
    if (rate === null) return 0;
    const spend = rate === '1' ? input.spend : input.spend * Number(rate);
    await tx
      .insert(loyaltyAccounts)
      .values({ customerId: input.customerId, companyId: input.companyId })
      .onConflictDoNothing();
    const [acct] = await tx
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.customerId, input.customerId))
      .for('update');
    const points = pointsEarned(spend, cfg, acct?.lifetimeEarned ?? 0);
    if (points <= 0) return 0;
    const at = input.at ?? new Date();
    const months = cfg.expiryMonths ?? 0;
    const expiresAt = months > 0 ? new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + months, at.getUTCDate())) : null;
    const inserted = await tx
      .insert(loyaltyLedger)
      .values({
        companyId: input.companyId,
        customerId: input.customerId,
        kind: 'earn',
        points,
        orderId: input.orderId,
        expiresAt,
        actor: 'system',
      })
      .onConflictDoNothing()
      .returning({ id: loyaltyLedger.id });
    if (inserted.length === 0) return 0;
    await tx
      .update(loyaltyAccounts)
      .set({
        balance: sql`${loyaltyAccounts.balance} + ${points}`,
        lifetimeEarned: sql`${loyaltyAccounts.lifetimeEarned} + ${points}`,
        updatedAt: new Date(),
      })
      .where(eq(loyaltyAccounts.customerId, input.customerId));
    return points;
  }

  /**
   * Spends points against an order. Fails, and spends nothing, if the customer does not have them
   * (the balance cannot go below zero, even with many orders at once).
   */
  async redeem(
    tx: Tx,
    input: {
      companyId: string;
      customerId: string;
      orderId: string;
      due: number;
      currency?: string;
      points?: number;
      actor: string;
    },
  ): Promise<{ points: number; value: number; base: number; rate: string }> {
    const cfg = await this.activeConfig(input.companyId);
    if (!cfg) throw new PricingConfigError('INVALID', 'There is no loyalty programme in force.');
    const [acct] = await tx
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.customerId, input.customerId))
      .for('update');
    const rate = await this.baseRate(tx, input.companyId, input.currency);
    if (rate === null) throw new PricingConfigError('INVALID', `There is no exchange rate for ${(input.currency ?? '').toUpperCase()} yet. Set it under Finance → Exchange rates before points can pay an order in that currency.`);
    // What is left to pay is worked out in the books' currency, where a point has its value; what the points cover is then
    // taken back to the order's currency, rounded down so they never cover more than is due.
    const dueBase = rate === '1' ? input.due : input.due * Number(rate);
    const r = redemption(dueBase, acct?.balance ?? 0, cfg, input.points);
    if (has(r.problem)) throw new PricingConfigError('INVALID', r.problem);
    const covers = rate === '1' ? r.value : Math.min(input.due, Math.floor((r.value / Number(rate)) * 100 + 1e-9) / 100);
    if (!(covers > 0)) throw new PricingConfigError('INVALID', 'No points can be used on this order.');
    const inserted = await tx
      .insert(loyaltyLedger)
      .values({
        companyId: input.companyId,
        customerId: input.customerId,
        kind: 'redeem',
        points: -r.points,
        orderId: input.orderId,
        actor: input.actor,
      })
      .onConflictDoNothing()
      .returning({ id: loyaltyLedger.id });
    if (inserted.length === 0)
      throw new PricingConfigError('CONFLICT', 'Points have already been used on this order.');
    const updated = await tx
      .update(loyaltyAccounts)
      .set({ balance: sql`${loyaltyAccounts.balance} - ${r.points}`, updatedAt: new Date() })
      .where(
        and(
          eq(loyaltyAccounts.customerId, input.customerId),
          sql`${loyaltyAccounts.balance} >= ${r.points}`,
        ),
      )
      .returning({ balance: loyaltyAccounts.balance });
    if (updated.length === 0)
      throw new PricingConfigError('INVALID', 'The customer no longer has enough points.');
    return { points: r.points, value: covers, base: r.value, rate };
  }

  /**
   * Undoes an order's points: the ones it earned are taken back (as far as the customer still has
   * them) and the ones it spent are given back. Each happens once.
   */
  async reverseOrder(tx: Tx, orderId: string): Promise<void> {
    const rows = await tx.select().from(loyaltyLedger).where(eq(loyaltyLedger.orderId, orderId));
    if (rows.length === 0) return;
    for (const r of rows) {
      if (r.kind !== 'earn' && r.kind !== 'redeem') continue;
      const [acct] = await tx
        .select()
        .from(loyaltyAccounts)
        .where(eq(loyaltyAccounts.customerId, r.customerId))
        .for('update');
      if (!acct) continue;
      if (r.kind === 'earn') {
        // Part of the earning may already have been taken back by credit notes.
        const taken = rows
          .filter((x) => x.kind === 'reverse_earn')
          .reduce((n, x) => n + -x.points, 0);
        const remaining = Math.max(0, r.points - taken);
        // The customer may have spent some already; take back only what is left.
        const back = Math.min(remaining, acct.balance);
        if (remaining <= 0) continue;
        await tx.insert(loyaltyLedger).values({
          companyId: r.companyId,
          customerId: r.customerId,
          kind: 'reverse_earn',
          points: -back,
          orderId,
          note:
            back < remaining
              ? `${remaining - back} of the points earned were already spent.`
              : 'Order cancelled.',
          actor: 'system',
        });
        await tx
          .update(loyaltyAccounts)
          .set({
            balance: sql`${loyaltyAccounts.balance} - ${back}`,
            lifetimeEarned: sql`greatest(0, ${loyaltyAccounts.lifetimeEarned} - ${remaining})`,
            updatedAt: new Date(),
          })
          .where(eq(loyaltyAccounts.customerId, r.customerId));
      } else {
        const back = -r.points;
        const inserted = await tx
          .insert(loyaltyLedger)
          .values({
            companyId: r.companyId,
            customerId: r.customerId,
            kind: 'reverse_redeem',
            points: back,
            orderId,
            actor: 'system',
          })
          .onConflictDoNothing()
          .returning({ id: loyaltyLedger.id });
        if (inserted.length === 0) continue;
        await tx
          .update(loyaltyAccounts)
          .set({ balance: sql`${loyaltyAccounts.balance} + ${back}`, updatedAt: new Date() })
          .where(eq(loyaltyAccounts.customerId, r.customerId));
      }
    }
  }

  /**
   * Takes back the share of an order's points that a credit note returned (a credit of a fifth of
   * the order takes back a fifth of the points), as far as the customer still has them.
   */
  async clawbackCredit(
    tx: Tx,
    input: { orderId: string; creditNoteNo: string; fraction: number },
  ): Promise<number> {
    const rows = await tx
      .select()
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.orderId, input.orderId));
    const earn = rows.find((r) => r.kind === 'earn');
    if (!earn || !(input.fraction > 0)) return 0;
    const taken = rows.filter((x) => x.kind === 'reverse_earn').reduce((n, x) => n + -x.points, 0);
    const remaining = Math.max(0, earn.points - taken);
    const [acct] = await tx
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.customerId, earn.customerId))
      .for('update');
    if (!acct) return 0;
    // Rounded down, so a customer is never charged for more than the share returned.
    const claw = Math.min(
      Math.floor(earn.points * Math.min(1, input.fraction) + 1e-9),
      remaining,
      acct.balance,
    );
    if (claw <= 0) return 0;
    await tx.insert(loyaltyLedger).values({
      companyId: earn.companyId,
      customerId: earn.customerId,
      kind: 'reverse_earn',
      points: -claw,
      orderId: input.orderId,
      note: `Credit note ${input.creditNoteNo}.`,
      actor: 'system',
    });
    await tx
      .update(loyaltyAccounts)
      .set({
        balance: sql`${loyaltyAccounts.balance} - ${claw}`,
        lifetimeEarned: sql`greatest(0, ${loyaltyAccounts.lifetimeEarned} - ${claw})`,
        updatedAt: new Date(),
      })
      .where(eq(loyaltyAccounts.customerId, earn.customerId));
    return claw;
  }

  // ── Staff ────────────────────────────────────────────────────────────────

  async account(companyId: string, customerId: string, limit = 50): Promise<LoyaltyAccountView> {
    const [customer] = await this.db
      .select({ id: customers.id, name: customers.name })
      .from(customers)
      .where(and(eq(customers.id, customerId), eq(customers.companyId, companyId)))
      .limit(1);
    if (!customer) throw new PricingConfigError('NOT_FOUND', 'That customer does not exist.');
    const [acct] = await this.db
      .select()
      .from(loyaltyAccounts)
      .where(eq(loyaltyAccounts.customerId, customerId))
      .limit(1);
    const ledger = await this.db
      .select()
      .from(loyaltyLedger)
      .where(eq(loyaltyLedger.customerId, customerId))
      .orderBy(desc(loyaltyLedger.createdAt))
      .limit(limit);
    const row = await this.programRow(companyId);
    const cfg = row ? toConfig(row) : null;
    const balance = acct?.balance ?? 0;
    return {
      customerId,
      customerName: customer.name,
      balance,
      lifetimeEarned: acct?.lifetimeEarned ?? 0,
      tier: cfg ? tierFor(acct?.lifetimeEarned ?? 0, cfg.tiers) : null,
      worth: cfg ? Math.round(balance * cfg.pointValue * 100) / 100 : 0,
      ledger: ledger.map((l) => ({
        id: l.id,
        kind: l.kind,
        points: l.points,
        orderId: l.orderId,
        note: l.note,
        expiresAt: l.expiresAt?.toISOString() ?? null,
        createdAt: l.createdAt.toISOString(),
      })),
    };
  }

  /** A staff correction: points added or taken away, with a reason. */
  async adjust(
    companyId: string,
    customerId: string,
    points: number,
    note: string | null,
    actor: { type: 'user'; id: string },
    reason: Why,
  ): Promise<LoyaltyAccountView> {
    const why = await this.reasons.require(companyId, reason, 'pricing_configuration');
    if (!Number.isInteger(points) || points === 0 || Math.abs(points) > 1_000_000)
      throw new PricingConfigError('INVALID', 'Enter a whole number of points, not zero.');
    await this.account(companyId, customerId, 1);
    await this.db.transaction(async (tx) => {
      await tx.insert(loyaltyAccounts).values({ customerId, companyId }).onConflictDoNothing();
      const updated = await tx
        .update(loyaltyAccounts)
        .set({
          balance: sql`${loyaltyAccounts.balance} + ${points}`,
          lifetimeEarned:
            points > 0
              ? sql`${loyaltyAccounts.lifetimeEarned} + ${points}`
              : loyaltyAccounts.lifetimeEarned,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(loyaltyAccounts.customerId, customerId),
            sql`${loyaltyAccounts.balance} + ${points} >= 0`,
          ),
        )
        .returning({ balance: loyaltyAccounts.balance });
      if (updated.length === 0)
        throw new PricingConfigError(
          'INVALID',
          'The customer does not have that many points to take away.',
        );
      const [entry] = await tx
        .insert(loyaltyLedger)
        .values({
          companyId,
          customerId,
          kind: 'adjust',
          points,
          note: trimToNull(note),
          reasonCode: why.code,
          actor: actor.id,
        })
        .returning({ id: loyaltyLedger.id });
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'customer', id: customerId },
          action: 'pricing.loyalty_adjusted',
          reason: why,
          outcome: { points, ledgerId: required(entry, 'the ledger row').id },
        },
        tx,
      );
    });
    return await this.account(companyId, customerId);
  }

  /**
   * Lapses points that were not spent in time. Points are spent oldest first, so the ones that
   * lapse are what the expired earnings exceed all the spending by. Run daily.
   */
  async expireDue(companyId: string, now: Date = new Date(), limit = 500): Promise<number> {
    const due = await this.db
      .selectDistinct({ customerId: loyaltyLedger.customerId })
      .from(loyaltyLedger)
      .where(
        and(
          eq(loyaltyLedger.companyId, companyId),
          eq(loyaltyLedger.kind, 'earn'),
          sql`${loyaltyLedger.expiresAt} <= ${now.toISOString()}`,
        ),
      )
      .limit(limit);
    let lapsed = 0;
    for (const { customerId } of due) {
      lapsed += await this.db.transaction(async (tx) => {
        const [acct] = await tx
          .select()
          .from(loyaltyAccounts)
          .where(eq(loyaltyAccounts.customerId, customerId))
          .for('update');
        if (!acct || acct.balance <= 0) return 0;
        const [t] = await tx
          .select({
            expired: sql<string>`coalesce(sum(case when ${loyaltyLedger.kind} = 'earn' and ${loyaltyLedger.expiresAt} <= ${now.toISOString()} then ${loyaltyLedger.points} else 0 end), 0)`,
            // Everything taken away so far (spent, expired, taken back), less what was given back.
            used: sql<string>`coalesce(sum(case when ${loyaltyLedger.points} < 0 then -${loyaltyLedger.points} when ${loyaltyLedger.kind} = 'reverse_redeem' then -${loyaltyLedger.points} else 0 end), 0)`,
          })
          .from(loyaltyLedger)
          .where(eq(loyaltyLedger.customerId, customerId));
        const lapse = Math.min(acct.balance, Math.max(0, Number(t?.expired ?? 0) - Number(t?.used ?? 0)));
        if (lapse <= 0) return 0;
        await tx.insert(loyaltyLedger).values({
          companyId,
          customerId,
          kind: 'expire',
          points: -lapse,
          note: 'Points expired.',
          actor: 'system',
        });
        await tx
          .update(loyaltyAccounts)
          .set({ balance: sql`${loyaltyAccounts.balance} - ${lapse}`, updatedAt: new Date() })
          .where(eq(loyaltyAccounts.customerId, customerId));
        return lapse;
      });
    }
    return lapsed;
  }
}
