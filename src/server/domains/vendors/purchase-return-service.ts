import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  products,
  purchaseOrderEvents,
  purchaseOrderLines,
  purchaseOrders,
  purchaseReturnEvents,
  purchaseReturnLines,
  purchaseReturns,
  rgnLines,
  rgns,
  users,
  vendors,
  type PurchaseOrderStatus,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { checkReturnHeader, checkReturnLines, returnable, type ReturnHeaderForm, type ReturnLineForm } from '@/lib/purchase-return';
import { receiptStatus } from '@/lib/rgn';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { applyStockDelta as applyStockDeltaFn } from '@/server/domains/inventory/service';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type ApplyStockDelta = typeof applyStockDeltaFn;
/** Orders whose status follows what has been received; once invoicing has started the status is left alone. */
const FOLLOWS_RECEIPT: PurchaseOrderStatus[] = ['sent', 'confirmed', 'partially_received', 'received'];

/**
 * Goods sent back to the vendor after they were received (design doc §12.3). Posting one takes the stock out at the cost it came
 * in at (the stock movement makes the books post Dr Stock received not invoiced / Cr Inventory), lowers what is received on the
 * order so it can be supplied again, and leaves the vendor's credit memo to settle the money. Goods already invoiced go back
 * after a credit memo has opened them again. Another person than the writer posts it.
 */
export class PurchaseReturnService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
  ) {}

  private async event(tx: Tx | DrizzleDb, ctx: FinanceContext, returnId: string, event: string, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(purchaseReturnEvents).values({ returnId, event, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: ctx.actor.type, actorId: ctx.actor.id });
  }

  private async lock(tx: Tx, companyId: string, id: string) {
    const [r] = await tx.select().from(purchaseReturns).where(and(eq(purchaseReturns.companyId, companyId), eq(purchaseReturns.id, id))).for('update');
    if (r === undefined) throw new FinanceError('NOT_FOUND', 'That return does not exist.');
    return r;
  }

  /** The lines of a posted note with how much of each can still go back. */
  async returnable(companyId: string, rgnId: string) {
    const [note] = await this.db.select().from(rgns).where(and(eq(rgns.companyId, companyId), eq(rgns.id, rgnId)));
    if (note === undefined) return null;
    const rows = await this.db
      .select({ l: rgnLines, description: purchaseOrderLines.description, unit: purchaseOrderLines.unit })
      .from(rgnLines)
      .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, rgnLines.poLineId))
      .where(eq(rgnLines.rgnId, rgnId));
    const held = await this.heldByDrafts(this.db, rows.map((r) => r.l.id));
    return {
      note: { id: note.id, number: note.number, status: note.status, poId: note.poId, vendorId: note.vendorId, receivedDate: note.receivedDate, deliveryNoteNo: note.deliveryNoteNo },
      lines: rows.map((r) => ({ rgnLineId: r.l.id, description: r.description, unit: r.unit, accepted: r.l.accepted, invoiced: r.l.invoicedQuantity, returned: r.l.returnedQuantity, room: returnable(Number(r.l.accepted), Number(r.l.invoicedQuantity), Number(r.l.returnedQuantity)) })).map((l) => ({ ...l, roomAfterDrafts: Math.max(0, Math.round((l.room - (held.get(l.rgnLineId) ?? 0)) * 1000) / 1000) })),
    };
  }

  /** Quantities other drafts already ask for, so two drafts do not promise the same goods. */
  private async heldByDrafts(db: Tx | DrizzleDb, rgnLineIds: string[], exceptReturnId: string | null = null): Promise<Map<string, number>> {
    if (rgnLineIds.length === 0) return new Map();
    const rows = await db
      .select({ id: purchaseReturnLines.rgnLineId, total: sql<string>`SUM(${purchaseReturnLines.quantity})::text` })
      .from(purchaseReturnLines)
      .innerJoin(purchaseReturns, eq(purchaseReturns.id, purchaseReturnLines.returnId))
      .where(and(inArray(purchaseReturnLines.rgnLineId, rgnLineIds), eq(purchaseReturns.status, 'draft'), exceptReturnId === null ? undefined : sql`${purchaseReturns.id} <> ${exceptReturnId}`))
      .groupBy(purchaseReturnLines.rgnLineId);
    return new Map(rows.map((r) => [r.id, Number(r.total)]));
  }

  async saveDraft(ctx: FinanceContext, id: string | null, rgnId: string, header: ReturnHeaderForm, lines: ReturnLineForm[], today: string = businessDate()): Promise<{ id: string }> {
    const first = Object.values(checkReturnHeader(header, today))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    if (lines.length === 0) throw new FinanceError('INVALID', 'Choose what is going back.');
    return await this.db.transaction(async (tx) => {
      const [note] = await tx.select().from(rgns).where(and(eq(rgns.companyId, ctx.companyId), eq(rgns.id, rgnId)));
      if (note?.status !== 'posted') throw new FinanceError('NOT_POSTED', 'Goods can only go back against a posted received goods note.');
      const noteLines = await tx.select().from(rgnLines).where(eq(rgnLines.rgnId, rgnId));
      const held = await this.heldByDrafts(tx, noteLines.map((l) => l.id), id);
      const room = new Map(noteLines.map((l) => [l.id, Math.max(0, returnable(Number(l.accepted), Number(l.invoicedQuantity), Number(l.returnedQuantity)) - (held.get(l.id) ?? 0))]));
      const checked = checkReturnLines(lines, room);
      const problem = Object.entries(checked.problems)[0];
      if (problem !== undefined) throw new FinanceError('INVALID', `Line ${String(Number(problem[0]) + 1)}: ${problem[1]}`);
      const values = { rgnId, poId: note.poId, vendorId: note.vendorId, returnDate: header.returnDate, reason: header.reason, vendorReference: trimToNull(header.vendorReference), notes: trimToNull(header.notes), updatedAt: new Date() };
      let returnId = id;
      if (id === null) {
        const [made] = await tx.insert(purchaseReturns).values({ companyId: ctx.companyId, createdBy: ctx.actor.id, ...values }).returning({ id: purchaseReturns.id });
        returnId = made?.id ?? null;
      } else {
        const r = await this.lock(tx, ctx.companyId, id);
        if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be changed.');
        if (r.rgnId !== rgnId) throw new FinanceError('INVALID', 'A return belongs to one note.');
        await tx.update(purchaseReturns).set(values).where(eq(purchaseReturns.id, id));
        await tx.delete(purchaseReturnLines).where(eq(purchaseReturnLines.returnId, id));
      }
      if (returnId === null) throw new FinanceError('FAILED', 'The return could not be saved.');
      await tx.insert(purchaseReturnLines).values(lines.map((l) => ({ returnId, rgnLineId: l.rgnLineId, poLineId: noteLines.find((n) => n.id === l.rgnLineId)?.poLineId ?? '', quantity: String(Math.round(Number(l.quantity) * 1000) / 1000) })));
      if (id === null) await this.event(tx, ctx, returnId, 'created', { data: { lines: lines.length } });
      return { id: returnId };
    });
  }

  async cancelDraft(ctx: FinanceContext, id: string, reason: string): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the return is cancelled.');
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be cancelled.');
      await tx.update(purchaseReturns).set({ status: 'cancelled', cancelReason: text.slice(0, 500), updatedAt: new Date() }).where(eq(purchaseReturns.id, id));
      await this.event(tx, ctx, id, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  async post(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string }> {
    const { applyStockDelta } = await import('@/server/domains/inventory/service');
    return await this.postIn(ctx, id, now, applyStockDelta);
  }

  private async postIn(ctx: FinanceContext, id: string, now: Date, applyStockDelta: ApplyStockDelta): Promise<{ number: string }> {
    return await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'This return was already posted or cancelled.');
      if (r.createdBy !== null && r.createdBy === ctx.actor.id) throw new FinanceError('FOUR_EYES', 'Another person has to post this return: you wrote it.');
      const [v] = await tx.select({ block: vendors.block }).from(vendors).where(eq(vendors.id, r.vendorId));
      if (v === undefined) throw new FinanceError('NOT_FOUND', 'The vendor does not exist.');
      const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, r.poId)).for('update');
      if (po === undefined) throw new FinanceError('NOT_FOUND', 'The order does not exist.');
      const lines = await tx.select().from(purchaseReturnLines).where(eq(purchaseReturnLines.returnId, id));
      const noteLines = await tx.select().from(rgnLines).where(inArray(rgnLines.id, lines.map((l) => l.rgnLineId))).for('update');
      const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, r.poId)).for('update');
      const number = (await this.numbering.assign('purchase_return', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'purchase_return', id } }, tx)).number;
      for (const l of lines) {
        const nl = noteLines.find((x) => x.id === l.rgnLineId);
        const pl = poLines.find((x) => x.id === l.poLineId);
        if (nl === undefined || pl === undefined) throw new FinanceError('NOT_FOUND', 'A line of this return is no longer on the note.');
        const qty = Number(l.quantity);
        const room = returnable(Number(nl.accepted), Number(nl.invoicedQuantity), Number(nl.returnedQuantity));
        if (Math.round(qty * 1000) > Math.round(room * 1000)) throw new FinanceError('TOO_MUCH', `“${pl.description}”: only ${String(room)} can still go back. Goods that were invoiced go back after the vendor’s credit memo has opened them again.`);
        if (pl.productId !== null && nl.unitCost !== null) {
          const [p] = await tx.select({ stock: products.stockQuantity, name: products.name }).from(products).where(eq(products.id, pl.productId)).for('update');
          if (p !== undefined && p.stock < qty) throw new FinanceError('STOCK_GONE', `Only ${String(p.stock)} of ${p.name} is in stock, so ${String(qty)} cannot go back: some was sold.`);
          await applyStockDelta(tx, { productId: pl.productId, delta: -qty, changeType: 'purchase_return', referenceId: number, actor: ctx.actor.id ?? 'system', note: `Returned to the vendor on ${number}: ${r.reason}`.slice(0, 250) });
        }
        await tx.update(rgnLines).set({ returnedQuantity: sql`${rgnLines.returnedQuantity} + ${String(qty)}::numeric` }).where(eq(rgnLines.id, nl.id));
        await tx.update(purchaseReturnLines).set({ unitCost: nl.unitCost }).where(eq(purchaseReturnLines.id, l.id));
        await tx.update(purchaseOrderLines).set({ receivedQuantity: String(Math.max(0, Math.round((Number(pl.receivedQuantity) - qty) * 1000) / 1000)) }).where(eq(purchaseOrderLines.id, pl.id));
      }
      await tx.update(purchaseReturns).set({ status: 'posted', number, postedBy: ctx.actor.id, postedAt: now, updatedAt: now }).where(eq(purchaseReturns.id, id));
      let status = po.status;
      if (FOLLOWS_RECEIPT.includes(po.status)) {
        const after = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, r.poId));
        const s = receiptStatus(after.map((l) => ({ quantity: Number(l.quantity), received: Number(l.receivedQuantity), cancelled: Number(l.cancelledQuantity) })));
        const idle: PurchaseOrderStatus = po.confirmedAt === null ? 'sent' : 'confirmed';
        status = s === 'none' ? idle : s;
        if (status !== po.status) await tx.update(purchaseOrders).set({ status, updatedAt: now }).where(eq(purchaseOrders.id, po.id));
      }
      await tx.insert(purchaseOrderEvents).values({ poId: po.id, event: 'goods_returned', fromStatus: po.status, toStatus: status, reasonText: r.reason, data: { return: number }, actorType: ctx.actor.type, actorId: ctx.actor.id });
      await this.event(tx, ctx, id, 'posted', { data: { number } });
      return { number };
    });
  }

  // ── reading ──────────────────────────────────────────────────────────────

  async list(companyId: string, f: { status?: string; rgnId?: string } = {}, limit = 100) {
    const rows = await this.db
      .select({ r: purchaseReturns, vendor: vendors.legalName, note: rgns.number })
      .from(purchaseReturns)
      .innerJoin(vendors, eq(vendors.id, purchaseReturns.vendorId))
      .innerJoin(rgns, eq(rgns.id, purchaseReturns.rgnId))
      .where(and(eq(purchaseReturns.companyId, companyId), has(f.status) ? eq(purchaseReturns.status, f.status as 'draft') : undefined, has(f.rgnId) ? eq(purchaseReturns.rgnId, f.rgnId) : undefined))
      .orderBy(desc(purchaseReturns.createdAt))
      .limit(Math.min(limit, 200));
    return rows.map(({ r, vendor, note }) => ({ id: r.id, number: r.number, status: r.status, vendorId: r.vendorId, vendor, rgnId: r.rgnId, note, returnDate: r.returnDate, reason: r.reason, createdAt: r.createdAt.toISOString() }));
  }

  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ r: purchaseReturns, vendor: vendors.legalName, note: rgns.number, po: purchaseOrders.number })
      .from(purchaseReturns)
      .innerJoin(vendors, eq(vendors.id, purchaseReturns.vendorId))
      .innerJoin(rgns, eq(rgns.id, purchaseReturns.rgnId))
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, purchaseReturns.poId))
      .where(and(eq(purchaseReturns.companyId, companyId), eq(purchaseReturns.id, id)));
    if (head === undefined) return null;
    const [lines, events] = await Promise.all([
      this.db.select({ l: purchaseReturnLines, description: purchaseOrderLines.description, unit: purchaseOrderLines.unit }).from(purchaseReturnLines).innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, purchaseReturnLines.poLineId)).where(eq(purchaseReturnLines.returnId, id)).orderBy(asc(purchaseOrderLines.position)),
      this.db.select().from(purchaseReturnEvents).where(eq(purchaseReturnEvents.returnId, id)).orderBy(desc(purchaseReturnEvents.id)).limit(100),
    ]);
    const ids = [...new Set([head.r.createdBy, head.r.postedBy, ...events.map((e) => e.actorId)].filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    const names = new Map((ids.length === 0 ? [] : await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? 'Someone'));
    const { r } = head;
    return {
      ret: { id: r.id, number: r.number, status: r.status, rgnId: r.rgnId, vendorId: r.vendorId, returnDate: r.returnDate, reason: r.reason, vendorReference: r.vendorReference, notes: r.notes, cancelReason: r.cancelReason, createdBy: r.createdBy },
      vendor: head.vendor,
      note: head.note,
      po: head.po,
      lines: lines.map((x) => ({ id: x.l.id, rgnLineId: x.l.rgnLineId, description: x.description, unit: x.unit, quantity: x.l.quantity, unitCost: x.l.unitCost })),
      createdName: who(r.createdBy),
      postedName: who(r.postedBy),
      events: events.map((e) => ({ id: e.id, event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }
}
