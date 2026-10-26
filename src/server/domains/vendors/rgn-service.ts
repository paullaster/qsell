import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { currencies, products, purchaseOrderEvents, purchaseOrderLines, purchaseOrders, rgnLines, rgns, unitsOfMeasure, vendorSettings, vendors, type PurchaseOrderStatus, type RgnRow } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { acceptedOf, checkRgnHeader, checkRgnLine, mostAcceptable, receiptStatus, sameUnit, type RgnHeaderForm, type RgnLineForm } from '@/lib/rgn';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { FxService } from '@/server/domains/finance/fx-service';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { applyStockDelta as applyStockDeltaFn } from '@/server/domains/inventory/service';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type ApplyStockDelta = typeof applyStockDeltaFn;

/** The order statuses in which goods may be received against it. */
const RECEIVABLE: PurchaseOrderStatus[] = ['sent', 'confirmed', 'partially_received'];

/**
 * Received goods notes (design doc §10): what arrived against one order, with the vendor's own delivery note number. Posting one
 * puts the accepted stock into inventory at the order's cost through the existing stock movement (so the existing finance job
 * posts Dr Inventory / Cr Stock received not invoiced), raises the order's received quantities, and moves the order along. A
 * posted note never changes; a mistake is reversed, which takes the stock out again and posts the mirror entry.
 */
export class RgnService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly fx: FxService,
  ) {}

  private async lock(tx: Tx, companyId: string, id: string): Promise<RgnRow> {
    const [r] = await tx.select().from(rgns).where(and(eq(rgns.companyId, companyId), eq(rgns.id, id))).for('update');
    if (r === undefined) throw new FinanceError('NOT_FOUND', 'That received goods note does not exist.');
    return r;
  }

  private async toleranceOf(db: Tx | DrizzleDb, companyId: string): Promise<number> {
    const [s] = await db.select({ t: vendorSettings.receiptTolerancePercent }).from(vendorSettings).where(eq(vendorSettings.companyId, companyId));
    return Number(s?.t ?? '0');
  }

  /** What is still to come on an order, line by line: the starting point of a new note. */
  async outstanding(companyId: string, poId: string) {
    const [po] = await this.db.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, companyId), eq(purchaseOrders.id, poId)));
    if (po === undefined) throw new FinanceError('NOT_FOUND', 'That purchase order does not exist.');
    const lines = await this.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId)).orderBy(asc(purchaseOrderLines.position));
    const tolerance = await this.toleranceOf(this.db, companyId);
    return {
      po,
      lines: lines.map((l) => ({
        id: l.id,
        description: l.description,
        unit: l.unit,
        productId: l.productId,
        ordered: l.quantity,
        received: l.receivedQuantity,
        toCome: String(Math.max(0, Math.round((Number(l.quantity) - Number(l.cancelledQuantity) - Number(l.receivedQuantity)) * 1000) / 1000)),
        mostAcceptable: String(mostAcceptable(Number(l.quantity), Number(l.receivedQuantity), Number(l.cancelledQuantity), tolerance)),
      })),
    };
  }

  /** Writes (id null) or rewrites a draft note. Lines with nothing delivered are left out. */
  async saveDraft(ctx: FinanceContext, id: string | null, poId: string, header: RgnHeaderForm, lines: RgnLineForm[]): Promise<{ id: string }> {
    const first = Object.values(checkRgnHeader(header))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    const kept = lines.filter((l) => l.delivered.trim() !== '' && Number(l.delivered) > 0);
    if (kept.length === 0) throw new FinanceError('INVALID', 'Enter what arrived on at least one line.');
    for (const l of kept) {
      const problem = Object.values(checkRgnLine(l))[0];
      if (has(problem)) throw new FinanceError('INVALID', problem);
    }
    if (new Set(kept.map((l) => l.poLineId)).size !== kept.length) throw new FinanceError('INVALID', 'A line can be received only once on a note.');
    return await this.db.transaction(async (tx) => {
      const [po] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.companyId, ctx.companyId), eq(purchaseOrders.id, poId)));
      if (po === undefined) throw new FinanceError('NOT_FOUND', 'That purchase order does not exist.');
      if (!RECEIVABLE.includes(po.status)) throw new FinanceError('NOT_RECEIVABLE', 'Goods are received against an order that has been sent to the vendor and is not finished or cancelled.');
      const orderLines = await tx.select({ id: purchaseOrderLines.id }).from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
      if (kept.some((l) => !orderLines.some((o) => o.id === l.poLineId))) throw new FinanceError('NOT_FOUND', 'One of those lines is not on this order.');
      let rgnId: string;
      const values = { receivedDate: header.receivedDate, deliveryNoteNo: header.deliveryNoteNo.trim(), vehicle: trimToNull(header.vehicle), notes: trimToNull(header.notes), updatedAt: new Date() };
      if (id === null) {
        const [made] = await tx.insert(rgns).values({ companyId: ctx.companyId, poId, vendorId: po.vendorId, receivedBy: ctx.actor.id, createdBy: ctx.actor.id, ...values }).returning({ id: rgns.id });
        if (made === undefined) throw new FinanceError('NOT_SAVED', 'The note could not be saved.');
        rgnId = made.id;
      } else {
        const r = await this.lock(tx, ctx.companyId, id);
        if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be edited. A posted note is reversed.');
        if (r.poId !== poId) throw new FinanceError('INVALID', 'A note stays with its order.');
        await tx.update(rgns).set(values).where(eq(rgns.id, id));
        await tx.delete(rgnLines).where(eq(rgnLines.rgnId, id));
        rgnId = id;
      }
      await tx.insert(rgnLines).values(kept.map((l) => {
        const rejected = l.rejected.trim() === '' ? '0' : l.rejected.trim();
        return { rgnId, poLineId: l.poLineId, delivered: l.delivered.trim(), accepted: String(acceptedOf(l)), rejected, rejectReason: Number(rejected) > 0 ? l.rejectReason : null };
      }));
      return { id: rgnId };
    });
  }

  /** Posts the note: stock in, the order's counters up, the order moved along, all in one transaction. */
  async post(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string }> {
    const { applyStockDelta } = await import('@/server/domains/inventory/service');
    try {
      return await this.postIn(ctx, id, now, applyStockDelta);
    } catch (error) {
      if (isUniqueViolation(error)) throw new FinanceError('DUPLICATE_NOTE', 'A note with this delivery note number was already posted for this vendor. A delivery is received once.');
      throw error;
    }
  }

  private async postIn(ctx: FinanceContext, id: string, now: Date, applyStockDelta: ApplyStockDelta): Promise<{ number: string }> {
    return await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'This note was already posted or cancelled.');
      const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, r.poId)).for('update');
      if (po === undefined || !RECEIVABLE.includes(po.status)) throw new FinanceError('NOT_RECEIVABLE', 'The order no longer takes goods.');
      const [v] = await tx.select({ block: vendors.block, status: vendors.status }).from(vendors).where(eq(vendors.id, r.vendorId));
      if (v?.block === 'all') throw new FinanceError('VENDOR_BLOCKED', 'This vendor is blocked from everything, so goods cannot be received from it.');
      const lines = await tx.select().from(rgnLines).where(eq(rgnLines.rgnId, id));
      const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, r.poId)).for('update');
      const tolerance = await this.toleranceOf(tx, ctx.companyId);
      const [{ base } = { base: 'KES' }] = await tx.select({ base: currencies.code }).from(currencies).where(eq(currencies.isBaseCurrency, true)).limit(1);
      const { number } = await this.numbering.assign('rgn', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'rgn', id } }, tx);
      for (const l of lines) {
        const pl = poLines.find((x) => x.id === l.poLineId);
        if (pl === undefined) throw new FinanceError('NOT_FOUND', 'A line of this note is no longer on the order.');
        const room = mostAcceptable(Number(pl.quantity), Number(pl.receivedQuantity), Number(pl.cancelledQuantity), tolerance);
        if (Number(l.accepted) > room + 1e-9) throw new FinanceError('OVER_RECEIPT', `“${pl.description}”: ${l.accepted} accepted, but only ${String(room)} more is allowed on the order${tolerance > 0 ? ` (with ${String(tolerance)}% tolerance)` : ''}. Refuse the extra, or amend the order first.`);
        let unitCost: string | null = null;
        if (pl.productId !== null && Number(l.accepted) > 0) {
          const [p] = await tx.select({ unitId: products.baseUnitId, name: products.name }).from(products).where(eq(products.id, pl.productId));
          const [u] = p === undefined ? [] : await tx.select({ code: unitsOfMeasure.code, name: unitsOfMeasure.name, symbol: unitsOfMeasure.symbol }).from(unitsOfMeasure).where(eq(unitsOfMeasure.id, p.unitId));
          if (u !== undefined && !sameUnit(pl.unit, u)) throw new FinanceError('UNIT_MISMATCH', `“${pl.description}” is ordered in ${pl.unit}, but ${p?.name ?? 'the product'} is counted in ${u.name}. Amend the order line to the same unit first.`);
          // Stock from an order in another currency costs what it is worth in the books' currency on the day it arrived.
          const rate = po.currency === base ? '1' : await this.fx.requireRate(tx, ctx.companyId, po.currency, r.receivedDate);
          const net = Number(pl.unitPrice) * (1 - Number(pl.discountPercent) / 100) * Number(rate);
          unitCost = net.toFixed(4);
          await applyStockDelta(tx, { productId: pl.productId, delta: Number(l.accepted), costPrice: Number(unitCost), changeType: 'purchase_order_receipt', referenceId: number, actor: ctx.actor.id ?? 'system', note: `Received on ${number} against ${po.number ?? 'an order'}; vendor delivery note ${r.deliveryNoteNo}` });
        }
        await tx.update(rgnLines).set({ unitCost }).where(eq(rgnLines.id, l.id));
        await tx.update(purchaseOrderLines).set({ receivedQuantity: String(Math.round((Number(pl.receivedQuantity) + Number(l.accepted)) * 1000) / 1000) }).where(eq(purchaseOrderLines.id, pl.id));
      }
      await tx.update(rgns).set({ status: 'posted', number, postedAt: now, postedBy: ctx.actor.id, updatedAt: now }).where(eq(rgns.id, id));
      const status = await this.advance(tx, po.id, po.status, now);
      await tx.insert(purchaseOrderEvents).values({ poId: po.id, event: 'goods_received', fromStatus: po.status, toStatus: status, data: { rgn: number, deliveryNote: r.deliveryNoteNo }, actorType: ctx.actor.type, actorId: ctx.actor.id });
      return { number };
    });
  }

  /** Moves the order to received / partly received from what is on its lines; back to confirmed or sent when nothing is. */
  private async advance(tx: Tx, poId: string, was: PurchaseOrderStatus, now: Date): Promise<PurchaseOrderStatus> {
    const lines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, poId));
    const s = receiptStatus(lines.map((l) => ({ quantity: Number(l.quantity), received: Number(l.receivedQuantity), cancelled: Number(l.cancelledQuantity) })));
    const [po] = await tx.select({ confirmedAt: purchaseOrders.confirmedAt }).from(purchaseOrders).where(eq(purchaseOrders.id, poId));
    const idle: PurchaseOrderStatus = po?.confirmedAt == null ? 'sent' : 'confirmed';
    const next: PurchaseOrderStatus = s === 'none' ? idle : s;
    if (next !== was) await tx.update(purchaseOrders).set({ status: next, updatedAt: now }).where(eq(purchaseOrders.id, poId));
    return next;
  }

  async cancelDraft(ctx: FinanceContext, id: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be cancelled. A posted note is reversed.');
      await tx.update(rgns).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(rgns.id, id));
    });
  }

  /**
   * Undoes a posted note. Refused once any of it was invoiced (use a purchase return instead) or when the stock is no longer
   * there to take out. Takes the stock out, reopens the order's lines, and posts the mirror of what the receipt posted.
   */
  async reverse(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the note is reversed.');
    const { applyStockDelta } = await import('@/server/domains/inventory/service');
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'posted') throw new FinanceError('NOT_POSTED', 'Only a posted note can be reversed.');
      const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, r.poId)).for('update');
      const lines = await tx.select().from(rgnLines).where(eq(rgnLines.rgnId, id));
      if (lines.some((l) => Number(l.returnedQuantity) > 0)) throw new FinanceError('ALREADY_RETURNED', 'Part of this note was sent back to the vendor, so it can no longer be reversed.');
      if (lines.some((l) => Number(l.invoicedQuantity) > 0)) throw new FinanceError('ALREADY_INVOICED', 'Part of this note was invoiced. Reverse it by a purchase return and a credit memo instead.');
      const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, r.poId)).for('update');
      for (const l of lines) {
        const pl = poLines.find((x) => x.id === l.poLineId);
        if (pl === undefined) continue;
        if (pl.productId !== null && Number(l.accepted) > 0) {
          const [p] = await tx.select({ stock: products.stockQuantity, name: products.name }).from(products).where(eq(products.id, pl.productId)).for('update');
          if (p !== undefined && p.stock < Number(l.accepted)) throw new FinanceError('STOCK_GONE', `Only ${String(p.stock)} of ${p.name} is in stock, so ${l.accepted} cannot be taken out: some was sold. Use a purchase return.`);
          await applyStockDelta(tx, { productId: pl.productId, delta: -Number(l.accepted), changeType: 'purchase_receipt_reversal', referenceId: r.number ?? id, actor: ctx.actor.id ?? 'system', note: `Reversal of ${r.number ?? 'a note'}: ${text.slice(0, 200)}` });
        }
        await tx.update(purchaseOrderLines).set({ receivedQuantity: String(Math.max(0, Math.round((Number(pl.receivedQuantity) - Number(l.accepted)) * 1000) / 1000)) }).where(eq(purchaseOrderLines.id, pl.id));
      }
      await tx.update(rgns).set({ status: 'reversed', reversedAt: now, reversedBy: ctx.actor.id, reverseReason: text.slice(0, 500), updatedAt: now }).where(eq(rgns.id, id));
      const status = po === undefined ? 'sent' : await this.advance(tx, po.id, po.status, now);
      await tx.insert(purchaseOrderEvents).values({ poId: r.poId, event: 'goods_receipt_reversed', fromStatus: po?.status ?? null, toStatus: status, reasonText: text.slice(0, 500), data: { rgn: r.number }, actorType: ctx.actor.type, actorId: ctx.actor.id });
    });
  }

  async list(companyId: string, f: { status?: string; poId?: string; before?: { createdAt: string; id: string } | null; limit?: number } = {}) {
    const limit = Math.min(Math.max(f.limit ?? 50, 1), 100);
    const conds = [eq(rgns.companyId, companyId)];
    if (has(f.status)) conds.push(eq(rgns.status, f.status as RgnRow['status']));
    if (has(f.poId)) conds.push(eq(rgns.poId, f.poId));
    if (f.before) conds.push(sql`(${rgns.createdAt}::text, ${rgns.id}::text) < (${f.before.createdAt}, ${f.before.id})`);
    const found = await this.db
      .select({ r: rgns, vendor: vendors.legalName, poNumber: purchaseOrders.number, stamp: sql<string>`${rgns.createdAt}::text` })
      .from(rgns)
      .innerJoin(vendors, eq(vendors.id, rgns.vendorId))
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, rgns.poId))
      .where(and(...conds))
      .orderBy(desc(rgns.createdAt), desc(rgns.id))
      .limit(limit + 1);
    const page = found.slice(0, limit);
    const last = page.at(-1);
    return { rows: page.map((x) => ({ ...x.r, vendorName: x.vendor, poNumber: x.poNumber })), next: found.length > limit && last !== undefined ? { createdAt: last.stamp, id: last.r.id } : null };
  }

  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ r: rgns, vendor: vendors.legalName, poNumber: purchaseOrders.number, poStatus: purchaseOrders.status })
      .from(rgns)
      .innerJoin(vendors, eq(vendors.id, rgns.vendorId))
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, rgns.poId))
      .where(and(eq(rgns.companyId, companyId), eq(rgns.id, id)));
    if (head === undefined) return null;
    const lines = await this.db
      .select({ l: rgnLines, description: purchaseOrderLines.description, unit: purchaseOrderLines.unit, ordered: purchaseOrderLines.quantity })
      .from(rgnLines)
      .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, rgnLines.poLineId))
      .where(eq(rgnLines.rgnId, id))
      .orderBy(asc(purchaseOrderLines.position));
    return { rgn: head.r, vendorName: head.vendor, poNumber: head.poNumber, poStatus: head.poStatus, lines };
  }

  /** Posted notes of one order, as the vendor may see them: what was accepted and refused, and why. */
  async deliveries(poId: string) {
    const notes = await this.db.select().from(rgns).where(and(eq(rgns.poId, poId), inArray(rgns.status, ['posted', 'reversed']))).orderBy(desc(rgns.receivedDate));
    if (notes.length === 0) return [];
    const lines = await this.db
      .select({ l: rgnLines, description: purchaseOrderLines.description, unit: purchaseOrderLines.unit })
      .from(rgnLines)
      .innerJoin(purchaseOrderLines, eq(purchaseOrderLines.id, rgnLines.poLineId))
      .where(inArray(rgnLines.rgnId, notes.map((n) => n.id)));
    return notes.map((n) => ({ number: n.number, receivedDate: n.receivedDate, deliveryNoteNo: n.deliveryNoteNo, status: n.status, lines: lines.filter((x) => x.l.rgnId === n.id).map((x) => ({ description: x.description, unit: x.unit, delivered: x.l.delivered, accepted: x.l.accepted, rejected: x.l.rejected, rejectReason: x.l.rejectReason })) }));
  }

  /**
   * Received, not yet invoiced: every posted line with accepted goods nobody has invoiced, with what it is worth and how old it is.
   * Business Central's "uninvoiced receipts". It should equal what sits in the stock-received-not-invoiced account.
   */
  async notInvoiced(companyId: string, today: string = businessDate()) {
    const rows = await this.db.execute<{ rgn: string; po: string | null; vendor: string; description: string; unit: string; open_qty: string; unit_cost: string | null; value: string; received_date: string; age_days: number }>(sql`
      SELECT r.number AS rgn, p.number AS po, v.legal_name AS vendor, pl.description, pl.unit,
        (l.accepted - l.returned_quantity - l.invoiced_quantity)::text AS open_qty, l.unit_cost::text AS unit_cost,
        ROUND((l.accepted - l.returned_quantity - l.invoiced_quantity) * COALESCE(l.unit_cost, pl.unit_price * (1 - pl.discount_percent / 100)), 2)::text AS value,
        r.received_date::text AS received_date, (${today}::date - r.received_date)::int AS age_days
      FROM rgn_lines l JOIN rgns r ON r.id = l.rgn_id JOIN purchase_orders p ON p.id = r.po_id JOIN vendors v ON v.id = r.vendor_id
      JOIN purchase_order_lines pl ON pl.id = l.po_line_id
      WHERE r.company_id = ${companyId}::uuid AND r.status = 'posted' AND l.accepted - l.returned_quantity > l.invoiced_quantity
      ORDER BY r.received_date, r.number LIMIT 500`);
    const list = [...rows].map((x) => ({ rgn: x.rgn, po: x.po, vendor: x.vendor, description: x.description, unit: x.unit, openQuantity: x.open_qty, unitCost: x.unit_cost, value: x.value, receivedDate: x.received_date, ageDays: x.age_days }));
    return { rows: list, totalValue: list.reduce((s, x) => s + Math.round(Number(x.value) * 100), 0) / 100 };
  }
}
