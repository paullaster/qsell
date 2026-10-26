import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { landedCostEvents, landedCostLines, landedCosts, products, purchaseOrderLines, rgnLines, rgns, users, vendors } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { checkLandedCost, costAfter, spread, type LandedCostForm } from '@/lib/landed-cost';
import { fromCents, toCents } from '@/lib/vendor-payment';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/**
 * Landed costs (design doc §23): freight, duty or insurance spread over the stock lines of one received goods note and added to
 * what that stock costs. The cost of a product is kept to the cent, as everywhere; the books follow the change through the existing
 * stock revaluation, so what reaches them can differ from the charge by a few cents (shown as "capitalised"). Goods already sold
 * are not touched: a charge is refused while part of the note's stock has gone, because that part's cost of sales is already booked.
 */
export class LandedCostService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
  ) {}

  private async event(tx: Tx | DrizzleDb, ctx: FinanceContext, id: string, event: string, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(landedCostEvents).values({ landedCostId: id, event, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: ctx.actor.type, actorId: ctx.actor.id });
  }

  private async lock(tx: Tx, companyId: string, id: string) {
    const [r] = await tx.select().from(landedCosts).where(and(eq(landedCosts.companyId, companyId), eq(landedCosts.id, id))).for('update');
    if (r === undefined) throw new FinanceError('NOT_FOUND', 'That landed cost does not exist.');
    return r;
  }

  /** The stock lines of a note a charge can be spread over, with what each is worth now. */
  async eligibleLines(db: Tx | DrizzleDb, rgnId: string) {
    const rows = await db
      .select({ l: rgnLines, productId: purchaseOrderLines.productId, description: purchaseOrderLines.description, unit: purchaseOrderLines.unit })
      .from(rgnLines)
      .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, rgnLines.poLineId))
      .where(eq(rgnLines.rgnId, rgnId))
      .orderBy(asc(purchaseOrderLines.position));
    return rows.flatMap((r) => {
      const qty = Math.round((Number(r.l.accepted) - Number(r.l.returnedQuantity)) * 1000) / 1000;
      return r.productId === null || r.l.unitCost === null || qty <= 0 ? [] : [{ rgnLineId: r.l.id, productId: r.productId, description: r.description, unit: r.unit, quantity: qty, unitCost: r.l.unitCost }];
    });
  }

  async saveDraft(ctx: FinanceContext, id: string | null, rgnId: string, form: LandedCostForm): Promise<{ id: string }> {
    const first = Object.values(checkLandedCost(form))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    try {
      return await this.db.transaction(async (tx) => {
        const [note] = await tx.select().from(rgns).where(and(eq(rgns.companyId, ctx.companyId), eq(rgns.id, rgnId)));
        if (note?.status !== 'posted') throw new FinanceError('NOT_POSTED', 'A charge is added to goods through a posted received goods note.');
        if ((await this.eligibleLines(tx, rgnId)).length === 0) throw new FinanceError('NO_STOCK_LINES', 'This note has no stock lines left to add the charge to.');
        const values = { rgnId, vendorId: note.vendorId, kind: form.kind, description: form.description.trim(), reference: form.reference.trim(), amount: fromCents(toCents(form.amount)), method: form.method, updatedAt: new Date() };
        if (id === null) {
          const [made] = await tx.insert(landedCosts).values({ companyId: ctx.companyId, createdBy: ctx.actor.id, ...values }).returning({ id: landedCosts.id });
          const newId = made?.id ?? '';
          await this.event(tx, ctx, newId, 'created', { data: { amount: values.amount, kind: form.kind } });
          return { id: newId };
        }
        const r = await this.lock(tx, ctx.companyId, id);
        if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be changed.');
        if (r.rgnId !== rgnId) throw new FinanceError('INVALID', 'A charge belongs to one note.');
        await tx.update(landedCosts).set(values).where(eq(landedCosts.id, id));
        return { id };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new FinanceError('DUPLICATE', 'This charge, on this note and with this reference, has already been entered.');
      throw error;
    }
  }

  async cancel(ctx: FinanceContext, id: string, reason: string): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why it is cancelled.');
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be cancelled.');
      await tx.update(landedCosts).set({ status: 'cancelled', cancelReason: text.slice(0, 500), updatedAt: new Date() }).where(eq(landedCosts.id, id));
      await this.event(tx, ctx, id, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  async post(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string; capitalisedCents: number }> {
    return await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'This charge was already posted or cancelled.');
      if (r.createdBy !== null && r.createdBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'Another person has to post this charge: you wrote it.');
      const lines = await this.eligibleLines(tx, r.rgnId);
      if (lines.length === 0) throw new FinanceError('NO_STOCK_LINES', 'This note has no stock lines left to add the charge to.');
      const weights = lines.map((l) => (r.method === 'quantity' ? l.quantity : l.quantity * Number(l.unitCost)));
      const shares = spread(toCents(r.amount), weights);
      const number = (await this.numbering.assign('landed_cost', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'landed_cost', id } }, tx)).number;
      let capitalised = 0;
      for (const [i, l] of lines.entries()) {
        const share = shares[i] ?? 0;
        const [p] = await tx.select({ stock: products.stockQuantity, cost: products.costPrice, name: products.name }).from(products).where(eq(products.id, l.productId)).for('update');
        if (p === undefined) throw new FinanceError('NOT_FOUND', `${l.description} is no longer a product.`);
        if (p.stock < l.quantity) throw new FinanceError('GOODS_SOLD', `Only ${String(p.stock)} of ${p.name} is in stock, less than the ${String(l.quantity)} this note brought in: some was sold, and its cost of sales is already booked. Spread the charge over a note whose goods are all still in stock, or expense it.`);
        const before = toCents(p.cost);
        const after = costAfter(before, share, p.stock);
        if (after !== before) await tx.update(products).set({ costPrice: fromCents(after) }).where(eq(products.id, l.productId));
        const value = Math.round(p.stock * (after - before));
        capitalised += value;
        await tx.insert(landedCostLines).values({ landedCostId: id, rgnLineId: l.rgnLineId, productId: l.productId, quantity: String(l.quantity), share: fromCents(share), costBefore: fromCents(before), costAfter: fromCents(after), capitalised: fromCents(value) });
      }
      await tx.update(landedCosts).set({ status: 'posted', number, postedBy: ctx.actor.id, postedAt: now, updatedAt: now }).where(eq(landedCosts.id, id));
      await this.event(tx, ctx, id, 'posted', { data: { number, capitalised: fromCents(capitalised) } });
      return { number, capitalisedCents: capitalised };
    });
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /** A preview for a draft: how the charge would be spread over the note's stock lines. */
  async preview(companyId: string, rgnId: string, amount: string, method: 'value' | 'quantity') {
    const [note] = await this.db.select({ id: rgns.id, number: rgns.number }).from(rgns).where(and(eq(rgns.companyId, companyId), eq(rgns.id, rgnId)));
    if (note === undefined) return null;
    const lines = await this.eligibleLines(this.db, rgnId);
    const shares = spread(Number.isFinite(Number(amount)) && Number(amount) > 0 ? toCents(amount) : 0, lines.map((l) => (method === 'quantity' ? l.quantity : l.quantity * Number(l.unitCost))));
    return { note, lines: lines.map((l, i) => ({ ...l, share: fromCents(shares[i] ?? 0) })) };
  }

  async list(companyId: string, f: { status?: string; rgnId?: string } = {}, limit = 100) {
    const rows = await this.db
      .select({ r: landedCosts, vendor: vendors.legalName, note: rgns.number })
      .from(landedCosts)
      .innerJoin(vendors, eq(vendors.id, landedCosts.vendorId))
      .innerJoin(rgns, eq(rgns.id, landedCosts.rgnId))
      .where(and(eq(landedCosts.companyId, companyId), has(f.status) ? eq(landedCosts.status, f.status as 'draft') : undefined, has(f.rgnId) ? eq(landedCosts.rgnId, f.rgnId) : undefined))
      .orderBy(desc(landedCosts.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(({ r, vendor, note }) => ({ id: r.id, number: r.number, status: r.status, vendor, note, rgnId: r.rgnId, kind: r.kind, description: r.description, reference: r.reference, amount: r.amount }));
  }

  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ r: landedCosts, vendor: vendors.legalName, note: rgns.number })
      .from(landedCosts)
      .innerJoin(vendors, eq(vendors.id, landedCosts.vendorId))
      .innerJoin(rgns, eq(rgns.id, landedCosts.rgnId))
      .where(and(eq(landedCosts.companyId, companyId), eq(landedCosts.id, id)));
    if (head === undefined) return null;
    const [lines, events] = await Promise.all([
      this.db.select({ l: landedCostLines, description: purchaseOrderLines.description, unit: purchaseOrderLines.unit }).from(landedCostLines).innerJoin(rgnLines, eq(rgnLines.id, landedCostLines.rgnLineId)).innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, rgnLines.poLineId)).where(eq(landedCostLines.landedCostId, id)).orderBy(asc(purchaseOrderLines.position)),
      this.db.select().from(landedCostEvents).where(eq(landedCostEvents.landedCostId, id)).orderBy(desc(landedCostEvents.id)).limit(100),
    ]);
    const ids = [...new Set([head.r.createdBy, head.r.postedBy, ...events.map((e) => e.actorId)].filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    const names = new Map((ids.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? 'Someone'));
    const { r } = head;
    const preview = r.status === 'draft' ? await this.preview(companyId, r.rgnId, r.amount, r.method) : null;
    return {
      cost: { id: r.id, number: r.number, status: r.status, rgnId: r.rgnId, kind: r.kind, description: r.description, reference: r.reference, amount: r.amount, method: r.method, cancelReason: r.cancelReason, createdBy: r.createdBy },
      vendor: head.vendor,
      note: head.note,
      lines: lines.map((x) => ({ id: x.l.id, description: x.description, unit: x.unit, quantity: x.l.quantity, share: x.l.share, costBefore: x.l.costBefore, costAfter: x.l.costAfter, capitalised: x.l.capitalised })),
      preview: preview === null ? null : preview.lines.map((l) => ({ rgnLineId: l.rgnLineId, description: l.description, unit: l.unit, quantity: l.quantity, share: l.share })),
      createdName: who(r.createdBy),
      postedName: who(r.postedBy),
      events: events.map((e) => ({ id: e.id, event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }
}

