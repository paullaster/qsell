import { and, asc, desc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { procurementCategories, purchaseRequisitionEvents, purchaseRequisitionLines, purchaseRequisitions, users, type PurchaseRequisitionRow } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { checkRequisitionHeader, checkRequisitionLine, estimatedTotalCents, type RequisitionHeaderForm, type RequisitionLineForm } from '@/lib/purchase-requisition';
import { emptyRfqHeader } from '@/lib/rfq';
import { emptyPoHeader, emptyPoLine } from '@/lib/purchase-order';
import { fromCents } from '@/lib/vendor-payment';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { RfqService } from './rfq-service';
import type { PurchaseOrderService } from './po-service';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
const MAX_LINES = 100;

/**
 * Purchase requisitions: someone asks to buy something, another person approves, and the approved request becomes a request for
 * quotation or an order draft carrying the same lines. A submitted requisition does not change (the database refuses it).
 */
export class RequisitionService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly rfqs: RfqService,
    private readonly orders: PurchaseOrderService,
  ) {}

  private async event(tx: Tx | DrizzleDb, ctx: FinanceContext, id: string, event: string, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(purchaseRequisitionEvents).values({ requisitionId: id, event, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: ctx.actor.type, actorId: ctx.actor.id });
  }

  private async lock(tx: Tx, companyId: string, id: string): Promise<PurchaseRequisitionRow> {
    const [r] = await tx.select().from(purchaseRequisitions).where(and(eq(purchaseRequisitions.companyId, companyId), eq(purchaseRequisitions.id, id))).for('update');
    if (r === undefined) throw new FinanceError('NOT_FOUND', 'That requisition does not exist.');
    return r;
  }

  async saveDraft(ctx: FinanceContext, id: string | null, header: RequisitionHeaderForm, lines: RequisitionLineForm[], today: string = businessDate()): Promise<{ id: string }> {
    const first = Object.values(checkRequisitionHeader(header, today))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    if (lines.length === 0) throw new FinanceError('INVALID', 'Add at least one line.');
    if (lines.length > MAX_LINES) throw new FinanceError('TOO_MANY', `A requisition can have at most ${String(MAX_LINES)} lines.`);
    lines.forEach((l, i) => {
      const problem = Object.values(checkRequisitionLine(l))[0];
      if (has(problem)) throw new FinanceError('INVALID', `Line ${String(i + 1)}: ${problem}`);
    });
    return await this.db.transaction(async (tx) => {
      const [cat] = await tx.select({ status: procurementCategories.status }).from(procurementCategories).where(and(eq(procurementCategories.companyId, ctx.companyId), eq(procurementCategories.id, header.categoryId)));
      if (cat === undefined || cat.status === 'archived') throw new FinanceError('NOT_FOUND', 'That category does not exist or is archived.');
      const values = { title: header.title.trim(), purpose: header.purpose.trim(), categoryId: header.categoryId, currency: header.currency.trim().toUpperCase(), neededBy: trimToNull(header.neededBy), estimatedTotal: fromCents(estimatedTotalCents(lines)), updatedAt: new Date() };
      let reqId = id;
      if (id === null) {
        const [made] = await tx.insert(purchaseRequisitions).values({ companyId: ctx.companyId, requesterId: ctx.actor.id, ...values }).returning({ id: purchaseRequisitions.id });
        reqId = made?.id ?? null;
        if (reqId !== null) await this.event(tx, ctx, reqId, 'created');
      } else {
        const r = await this.lock(tx, ctx.companyId, id);
        if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be changed.');
        if (r.requesterId !== null && r.requesterId !== ctx.actor.id) throw new FinanceError('NOT_YOURS', 'Only the person who wrote a requisition can change its draft.');
        await tx.update(purchaseRequisitions).set(values).where(eq(purchaseRequisitions.id, id));
        await tx.delete(purchaseRequisitionLines).where(eq(purchaseRequisitionLines.requisitionId, id));
      }
      if (reqId === null) throw new FinanceError('FAILED', 'The requisition could not be saved.');
      const rid = reqId;
      await tx.insert(purchaseRequisitionLines).values(lines.map((l, i) => ({ requisitionId: rid, position: i, productId: trimToNull(l.productId), description: l.description.trim(), specification: trimToNull(l.specification), quantity: String(Math.round(Number(l.quantity) * 1000) / 1000), unit: l.unit.trim(), estimatedUnitPrice: l.estimatedUnitPrice.trim() === '' ? '0' : l.estimatedUnitPrice.trim() })));
      return { id: rid };
    });
  }

  async submit(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string }> {
    return await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be sent for approval.');
      if (r.requesterId !== null && r.requesterId !== ctx.actor.id) throw new FinanceError('NOT_YOURS', 'Only the person who wrote a requisition can send it.');
      const number = r.number ?? (await this.numbering.assign('purchase_requisition', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'purchase_requisition', id } }, tx)).number;
      await tx.update(purchaseRequisitions).set({ status: 'submitted', number, submittedAt: now, rejectReason: null, updatedAt: now }).where(eq(purchaseRequisitions.id, id));
      await this.event(tx, ctx, id, 'submitted', { data: { number } });
      return { number };
    });
  }

  async approve(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'submitted') throw new FinanceError('WRONG_STATE', 'This requisition is not waiting for approval.');
      if (r.requesterId !== null && r.requesterId === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'Another person has to approve this requisition: you wrote it.');
      await tx.update(purchaseRequisitions).set({ status: 'approved', decidedBy: ctx.actor.id, decidedAt: now, updatedAt: now }).where(eq(purchaseRequisitions.id, id));
      await this.event(tx, ctx, id, 'approved');
    });
  }

  /** Sent back to the writer as a draft with the reason, or refused for good. */
  async reject(ctx: FinanceContext, id: string, reason: string, sendBack: boolean, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why.');
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'submitted') throw new FinanceError('WRONG_STATE', 'This requisition is not waiting for approval.');
      if (r.requesterId !== null && r.requesterId === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'Another person has to decide this requisition: you wrote it.');
      await tx.update(purchaseRequisitions).set(sendBack ? { status: 'draft', rejectReason: text.slice(0, 500), updatedAt: now } : { status: 'rejected', decidedBy: ctx.actor.id, decidedAt: now, rejectReason: text.slice(0, 500), updatedAt: now }).where(eq(purchaseRequisitions.id, id));
      await this.event(tx, ctx, id, sendBack ? 'sent_back' : 'rejected', { reason: text.slice(0, 500) });
    });
  }

  async cancel(ctx: FinanceContext, id: string, reason: string): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the requisition is cancelled.');
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (!['draft', 'submitted', 'approved'].includes(r.status)) throw new FinanceError('WRONG_STATE', 'This requisition is finished.');
      if (r.requesterId !== null && r.requesterId !== ctx.actor.id && r.status !== 'approved') throw new FinanceError('NOT_YOURS', 'Only the person who wrote a requisition can cancel it before it is approved.');
      await tx.update(purchaseRequisitions).set({ status: 'cancelled', cancelReason: text.slice(0, 500), updatedAt: new Date() }).where(eq(purchaseRequisitions.id, id));
      await this.event(tx, ctx, id, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  /** Reserves the requisition for a conversion, so two people cannot turn it into two documents. */
  private async claim(ctx: FinanceContext, id: string): Promise<{ r: PurchaseRequisitionRow; lines: (typeof purchaseRequisitionLines.$inferSelect)[] }> {
    return await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'approved') throw new FinanceError('WRONG_STATE', 'Only an approved requisition can be turned into an order or a request for quotation.');
      const lines = await tx.select().from(purchaseRequisitionLines).where(eq(purchaseRequisitionLines.requisitionId, id)).orderBy(asc(purchaseRequisitionLines.position));
      await tx.update(purchaseRequisitions).set({ convertedAt: new Date(), updatedAt: new Date() }).where(eq(purchaseRequisitions.id, id));
      return { r, lines };
    });
  }

  private async finish(ctx: FinanceContext, id: string, type: 'rfq' | 'purchase_order', targetId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.update(purchaseRequisitions).set({ status: 'converted', convertedType: type, convertedId: targetId, convertedAt: new Date(), updatedAt: new Date() }).where(eq(purchaseRequisitions.id, id));
      await this.event(tx, ctx, id, 'converted', { data: { type, id: targetId } });
    });
  }

  private async release(id: string): Promise<void> {
    await this.db.update(purchaseRequisitions).set({ convertedAt: null }).where(and(eq(purchaseRequisitions.id, id), eq(purchaseRequisitions.status, 'approved')));
  }

  async convertToRfq(ctx: FinanceContext, id: string, input: { deadline: string }): Promise<{ rfqId: string }> {
    const { r, lines } = await this.claim(ctx, id);
    try {
      const made = await this.rfqs.saveDraft(ctx, null, { ...emptyRfqHeader(), title: `${r.number ?? ''} ${r.title}`.trim().slice(0, 150), categoryId: r.categoryId, description: r.purpose, requiredBy: r.neededBy ?? '', deadline: input.deadline, currency: r.currency, estimatedValue: Number(r.estimatedTotal) > 0 ? r.estimatedTotal : '' }, lines.map((l) => ({ productId: l.productId ?? '', description: l.description, specification: l.specification ?? '', quantity: l.quantity, unit: l.unit, requiredDate: r.neededBy ?? '' })));
      await this.finish(ctx, id, 'rfq', made.id);
      return { rfqId: made.id };
    } catch (error) {
      await this.release(id);
      throw error;
    }
  }

  async convertToOrder(ctx: FinanceContext, id: string, input: { vendorId: string }, today: string = businessDate()): Promise<{ orderId: string }> {
    const { r, lines } = await this.claim(ctx, id);
    try {
      const made = await this.orders.saveDraft(
        ctx,
        null,
        { ...emptyPoHeader(today), vendorId: input.vendorId, categoryId: r.categoryId, currency: r.currency, expectedDate: r.neededBy ?? '', internalNotes: `From requisition ${r.number ?? ''}`.trim(), noRfqReason: `Raised from requisition ${r.number ?? ''}: ${r.title}`.slice(0, 300) },
        lines.map((l) => ({ ...emptyPoLine(), productId: l.productId ?? '', description: l.description, specification: l.specification ?? '', quantity: l.quantity, unit: l.unit, unitPrice: l.estimatedUnitPrice })),
        false,
      );
      await this.finish(ctx, id, 'purchase_order', made.id);
      return { orderId: made.id };
    } catch (error) {
      await this.release(id);
      throw error;
    }
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async list(companyId: string, f: { status?: string; mine?: string } = {}, limit = 100) {
    const rows = await this.db
      .select({ r: purchaseRequisitions, category: procurementCategories.name })
      .from(purchaseRequisitions)
      .innerJoin(procurementCategories, eq(procurementCategories.id, purchaseRequisitions.categoryId))
      .where(and(eq(purchaseRequisitions.companyId, companyId), has(f.status) ? eq(purchaseRequisitions.status, f.status as 'draft') : undefined, has(f.mine) ? eq(purchaseRequisitions.requesterId, f.mine) : undefined))
      .orderBy(desc(purchaseRequisitions.createdAt))
      .limit(Math.min(limit, 200));
    const ids = [...new Set(rows.map((x) => x.r.requesterId).filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    const names = new Map((ids.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
    return rows.map(({ r, category }) => ({ id: r.id, number: r.number, status: r.status, title: r.title, category, currency: r.currency, estimatedTotal: r.estimatedTotal, neededBy: r.neededBy, requester: r.requesterId === null ? null : (names.get(r.requesterId) ?? 'Someone'), createdAt: r.createdAt.toISOString() }));
  }

  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ r: purchaseRequisitions, category: procurementCategories.name })
      .from(purchaseRequisitions)
      .innerJoin(procurementCategories, eq(procurementCategories.id, purchaseRequisitions.categoryId))
      .where(and(eq(purchaseRequisitions.companyId, companyId), eq(purchaseRequisitions.id, id)));
    if (head === undefined) return null;
    const [lines, events] = await Promise.all([
      this.db.select().from(purchaseRequisitionLines).where(eq(purchaseRequisitionLines.requisitionId, id)).orderBy(asc(purchaseRequisitionLines.position)),
      this.db.select().from(purchaseRequisitionEvents).where(eq(purchaseRequisitionEvents.requisitionId, id)).orderBy(desc(purchaseRequisitionEvents.id)).limit(100),
    ]);
    const ids = [...new Set([head.r.requesterId, head.r.decidedBy, ...events.map((e) => e.actorId)].filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    const names = new Map((ids.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? 'Someone'));
    const { r } = head;
    return {
      req: { id: r.id, number: r.number, status: r.status, title: r.title, purpose: r.purpose, categoryId: r.categoryId, category: head.category, currency: r.currency, neededBy: r.neededBy, estimatedTotal: r.estimatedTotal, requesterId: r.requesterId, rejectReason: r.rejectReason, cancelReason: r.cancelReason, convertedType: r.convertedType, convertedId: r.convertedId },
      lines: lines.map((l) => ({ id: l.id, productId: l.productId, description: l.description, specification: l.specification ?? '', quantity: l.quantity, unit: l.unit, estimatedUnitPrice: l.estimatedUnitPrice })),
      requesterName: who(r.requesterId),
      decidedName: who(r.decidedBy),
      events: events.map((e) => ({ id: e.id, event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }
}
