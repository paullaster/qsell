import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  purchaseOrderLines,
  purchaseOrders,
  supplierInvoiceDeliveryNotes,
  supplierInvoiceEvents,
  supplierInvoiceLines,
  supplierInvoices,
  vendorFiles,
  vendors,
  type PurchaseOrderStatus,
  type SupplierInvoiceRow,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import {
  INVOICE_STATE,
  VENDOR_EDITABLE,
  canRecall,
  checkDeliveryNote,
  checkInvoiceHeader,
  checkInvoiceLine,
  deliveryNoteRule,
  invoiceTotals,
  reasonLabel,
  type DeliveryNoteForm,
  type InvoiceHeaderForm,
  type InvoiceLineForm,
} from '@/lib/supplier-invoice';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import type { AdvancePaymentService } from './advance-service';
import { roomsFor, writeEvent, type Actor, type Tx } from './invoice-support';
import type { VendorNotifier } from './notifier';
import { ProfileError, type PortalActor } from './profile-service';
import { FileRejected, type VendorFileStore } from './file-store';

/** Orders a vendor may invoice against: sent to them, not yet fully invoiced or finished. */
const INVOICEABLE: PurchaseOrderStatus[] = ['sent', 'confirmed', 'partially_received', 'received', 'partially_invoiced'];
const WRITERS = ['owner', 'finance'];
const actorOf = (a: PortalActor): Actor => ({ type: 'user', id: `vendor:${a.userId}` });
const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const money = (cents: number): string => (cents / 100).toFixed(2);

/**
 * The vendor's side of supplier invoices (design doc §11.2, §11.3, §11.7, §11.8): start one from an order, prepare it, send it,
 * take it back while nobody has touched it, close it, and correct and resend what was returned. The vendor and the order come
 * from the session and the database, never from the request; the totals are worked out here.
 */
export class SupplierInvoicePortalService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly files: VendorFileStore,
    private readonly advances: AdvancePaymentService,
    private readonly notify?: VendorNotifier,
  ) {}

  private mayWrite(actor: PortalActor): void {
    if (!WRITERS.includes(actor.portalRole)) throw new ProfileError('NOT_ALLOWED', 'Only the owner or the finance person can prepare or send invoices.');
  }

  private async mine(tx: Tx | DrizzleDb, actor: PortalActor, id: string, lock = false): Promise<SupplierInvoiceRow> {
    const q = tx.select().from(supplierInvoices).where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.vendorId, actor.vendorId)));
    const [row] = lock ? await q.for('update') : await q;
    if (row === undefined) throw new ProfileError('NOT_FOUND', 'That invoice does not exist.');
    return row;
  }

  /** The orders an invoice can be started from, newest first. */
  async orders(vendorId: string) {
    const rows = await this.db
      .select({ id: purchaseOrders.id, number: purchaseOrders.number, status: purchaseOrders.status, currency: purchaseOrders.currency, total: purchaseOrders.total, flagged: purchaseOrders.requiresAdvancePayment })
      .from(purchaseOrders)
      .where(and(eq(purchaseOrders.vendorId, vendorId), inArray(purchaseOrders.status, INVOICEABLE)))
      .orderBy(desc(purchaseOrders.createdAt))
      .limit(100);
    return rows.map((r) => ({ id: r.id, number: r.number ?? '', status: r.status, currency: r.currency, total: r.total, advance: r.flagged }));
  }

  async list(vendorId: string, before: { createdAt: string; id: string } | null = null, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const found = await this.db
      .select({ i: supplierInvoices, order: purchaseOrders.number, stamp: sql<string>`${supplierInvoices.createdAt}::text` })
      .from(supplierInvoices)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, supplierInvoices.poId))
      .where(and(eq(supplierInvoices.vendorId, vendorId), before === null ? sql`true` : sql`(${supplierInvoices.createdAt}::text, ${supplierInvoices.id}::text) < (${before.createdAt}, ${before.id})`))
      .orderBy(desc(supplierInvoices.createdAt), desc(supplierInvoices.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const last = page.at(-1);
    return {
      rows: page.map((x) => ({ id: x.i.id, number: x.i.number, vendorInvoiceNo: x.i.vendorInvoiceNo, state: x.i.state, orderNumber: x.order ?? '', total: x.i.total, currency: x.i.currency, invoiceDate: x.i.invoiceDate, needsAction: x.i.state === 'returned' })),
      next: found.length > take && last !== undefined ? { createdAt: last.stamp, id: last.i.id } : null,
    };
  }

  /** Starts a draft from an order: the lines are the goods that arrived and have not been invoiced, at the order's prices. */
  async start(actor: PortalActor, companyId: string, input: { poId: string; vendorInvoiceNo: string }, now: Date = new Date()): Promise<{ id: string }> {
    this.mayWrite(actor);
    const no = input.vendorInvoiceNo.trim();
    if (no === '' || no.length > 40) throw new ProfileError('INVALID', 'Enter the number printed on your invoice (40 characters at most).', { vendorInvoiceNo: 'Enter the number printed on your invoice.' });
    try {
      return await this.db.transaction(async (tx) => {
        const [po] = await tx.select().from(purchaseOrders).where(and(eq(purchaseOrders.id, input.poId), eq(purchaseOrders.vendorId, actor.vendorId), inArray(purchaseOrders.status, INVOICEABLE)));
        if (po === undefined) throw new ProfileError('NOT_FOUND', 'That order cannot be invoiced. It may not have been sent to you yet, or it is already fully invoiced.');
        const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, po.id)).orderBy(asc(purchaseOrderLines.position));
        const rooms = await roomsFor(tx, po.id, null);
        const advance = (await this.advances.hasCover(po.id)).ok;
        const use = poLines
          .map((l) => ({ l, room: rooms.get(l.id)?.goodsRoom ?? 0 }))
          .filter((x) => x.room > 0);
        // With no goods yet, an order that has an approved advance starts from its whole quantity.
        let chosen = use;
        if (use.length === 0 && advance) chosen = poLines.map((l) => ({ l, room: rooms.get(l.id)?.advanceRoom ?? 0 })).filter((x) => x.room > 0);
        if (chosen.length === 0) throw new ProfileError('NOTHING_TO_INVOICE', 'Nothing on this order is waiting to be invoiced. Goods must be received first.');
        const [made] = await tx
          .insert(supplierInvoices)
          .values({ companyId, vendorId: actor.vendorId, poId: po.id, vendorInvoiceNo: no, currency: po.currency, invoiceDate: businessDate(now), createdByPortalUser: actor.userId })
          .returning({ id: supplierInvoices.id });
        if (made === undefined) throw new ProfileError('FAILED', 'The invoice could not be started.');
        let position = 1;
        const lines = chosen.map(({ l, room }) => {
          const price = (Number(l.unitPrice) * (1 - Number(l.discountPercent) / 100)).toFixed(2);
          const a = invoiceTotals([{ quantity: String(room), unitPrice: price, taxRate: l.taxRate }]);
          return { invoiceId: made.id, position: position++, poLineId: l.id, description: l.description, unit: l.unit, quantity: String(room), unitPrice: price, taxRate: l.taxRate, netAmount: money(a.subtotal), taxAmount: money(a.tax) };
        });
        await tx.insert(supplierInvoiceLines).values(lines);
        const totals = invoiceTotals(lines.map((x) => ({ quantity: x.quantity, unitPrice: x.unitPrice, taxRate: x.taxRate })));
        await tx.update(supplierInvoices).set({ subtotal: money(totals.subtotal), taxTotal: money(totals.tax), total: money(totals.total) }).where(eq(supplierInvoices.id, made.id));
        await writeEvent(tx, actorOf(actor), made.id, 'created', null, 'draft', { data: { order: po.number } });
        return { id: made.id };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProfileError('DUPLICATE', 'You already have an invoice with this number. Open it from your invoices, or use a different number.', { vendorInvoiceNo: 'You already have an invoice with this number.' });
      throw error;
    }
  }

  async load(actor: PortalActor, id: string) {
    const inv = await this.mine(this.db, actor, id);
    const [po, lines, notes, events, file, orderLines] = await Promise.all([
      this.db.select().from(purchaseOrders).where(eq(purchaseOrders.id, inv.poId)).then((r) => r[0]),
      this.db.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, id)).orderBy(asc(supplierInvoiceLines.position)),
      this.db
        .select({ n: supplierInvoiceDeliveryNotes, fileName: vendorFiles.fileName })
        .from(supplierInvoiceDeliveryNotes)
        .innerJoin(vendorFiles, eq(vendorFiles.id, supplierInvoiceDeliveryNotes.fileId))
        .where(eq(supplierInvoiceDeliveryNotes.invoiceId, id))
        .orderBy(asc(supplierInvoiceDeliveryNotes.noteDate)),
      this.db.select().from(supplierInvoiceEvents).where(eq(supplierInvoiceEvents.invoiceId, id)).orderBy(asc(supplierInvoiceEvents.id)),
      inv.invoiceFileId === null ? Promise.resolve(undefined) : this.db.select({ id: vendorFiles.id, fileName: vendorFiles.fileName }).from(vendorFiles).where(eq(vendorFiles.id, inv.invoiceFileId)).then((r) => r[0]),
      this.db.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, inv.poId)),
    ]);
    const rooms = await roomsFor(this.db, inv.poId, id);
    const byLine = new Map(orderLines.map((l) => [l.id, l]));
    const cover = await this.advances.hasCover(inv.poId);
    const rule = deliveryNoteRule({ deliveryNotes: notes.length, orders: [{ number: po?.number ?? '', flagged: po?.requiresAdvancePayment ?? false, cover: cover.ok }] });
    const editable = (VENDOR_EDITABLE as readonly string[]).includes(inv.state);
    return {
      id: inv.id,
      number: inv.number,
      vendorInvoiceNo: inv.vendorInvoiceNo,
      state: inv.state,
      stateLabel: INVOICE_STATE[inv.state].label,
      stateWords: INVOICE_STATE[inv.state].vendorWords,
      revision: inv.revision,
      orderId: inv.poId,
      orderNumber: po?.number ?? '',
      currency: inv.currency,
      invoiceDate: inv.invoiceDate,
      dueDate: inv.dueDate ?? '',
      notes: inv.notes ?? '',
      declaration: inv.declaration,
      subtotal: inv.subtotal,
      taxTotal: inv.taxTotal,
      total: inv.total,
      invoiceFile: file === undefined ? null : { id: file.id, name: file.fileName },
      advanceAllowed: rule.ok || notes.length > 0 ? cover.ok && (po?.requiresAdvancePayment ?? false) : false,
      noteRuleReason: rule.reason,
      editable,
      canWrite: WRITERS.includes(actor.portalRole),
      canRecall: canRecall(inv.state, inv.firstActionAt?.toISOString() ?? null),
      canClose: editable,
      returnReason: inv.state === 'returned' ? { label: reasonLabel(inv.returnReasonCode ?? 'other'), note: inv.returnNote ?? '' } : null,
      rejectReason: inv.state === 'rejected' ? { label: reasonLabel(inv.rejectReasonCode ?? 'other'), note: inv.rejectNote ?? '' } : null,
      lines: lines.map((l) => {
        const pl = byLine.get(l.poLineId);
        const room = rooms.get(l.poLineId);
        return { id: l.id, poLineId: l.poLineId, description: l.description, unit: l.unit, quantity: l.quantity, unitPrice: l.unitPrice, taxRate: l.taxRate, netAmount: l.netAmount, taxAmount: l.taxAmount, orderPrice: pl === undefined ? '' : (Number(pl.unitPrice) * (1 - Number(pl.discountPercent) / 100)).toFixed(2), goodsRoom: String(room?.goodsRoom ?? 0), advanceRoom: String(room?.advanceRoom ?? 0) };
      }),
      deliveryNotes: notes.map((x) => ({ id: x.n.id, noteNo: x.n.noteNo, noteDate: x.n.noteDate, fileId: x.n.fileId, fileName: x.fileName })),
      timeline: events
        .map((e) => ({ event: e.event, at: e.createdAt.toISOString(), note: e.event === 'returned' || e.event === 'rejected' ? (e.reasonText ?? '') : '' }))
        .filter((e) => ['submitted', 'picked_up', 'linked', 'matched', 'approved', 'posted', 'returned', 'rejected', 'recalled', 'closed'].includes(e.event)),
    };
  }

  /** The vendor's own files only: a scan of the invoice or a signed delivery note. */
  async addFile(actor: PortalActor, companyId: string, input: { originalName: string; data: Buffer }): Promise<{ id: string; name: string }> {
    this.mayWrite(actor);
    try {
      const stored = await this.files.put({ companyId, vendorId: actor.vendorId, originalName: input.originalName, data: input.data, createdBy: `vendor:${actor.userId}` });
      return { id: stored.id, name: stored.fileName };
    } catch (error) {
      if (error instanceof FileRejected) throw new ProfileError('FILE', error.message);
      throw error;
    }
  }

  /** Saves everything the vendor can change, as one: header, lines (prices and quantities), delivery notes and the invoice scan. */
  async save(
    actor: PortalActor,
    id: string,
    input: { header: InvoiceHeaderForm; lines: InvoiceLineForm[]; deliveryNotes: DeliveryNoteForm[]; invoiceFileId: string },
    now: Date = new Date(),
  ): Promise<{ subtotal: string; taxTotal: string; total: string }> {
    this.mayWrite(actor);
    const today = businessDate(now);
    const problems: Record<string, string> = {};
    for (const [k, v] of Object.entries(checkInvoiceHeader(input.header, today))) problems[k] = v;
    input.lines.forEach((l, i) => {
      for (const [k, v] of Object.entries(checkInvoiceLine(l))) problems[`line.${String(i)}.${k}`] = v;
    });
    input.deliveryNotes.forEach((n, i) => {
      for (const [k, v] of Object.entries(checkDeliveryNote(n, today))) problems[`note.${String(i)}.${k}`] = v;
    });
    if (new Set(input.lines.map((l) => l.poLineId)).size !== input.lines.length) problems.lines = 'Each order line can be on the invoice once.';
    if (new Set(input.deliveryNotes.map((n) => n.noteNo.trim().toLowerCase())).size !== input.deliveryNotes.length) problems.notes = 'Each delivery note can be added once.';
    if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', 'Please correct the highlighted fields.', problems);
    try {
      return await this.db.transaction(async (tx) => {
        const inv = await this.mine(tx, actor, id, true);
        if (!(VENDOR_EDITABLE as readonly string[]).includes(inv.state)) throw new ProfileError('LOCKED', 'This invoice has been sent and cannot be changed now. If it has not been opened yet you can take it back first.');
        const poLines = await tx.select().from(purchaseOrderLines).where(eq(purchaseOrderLines.poId, inv.poId));
        const byId = new Map(poLines.map((l) => [l.id, l]));
        const fileIds = [...new Set([input.invoiceFileId, ...input.deliveryNotes.map((n) => n.fileId)].filter(has))];
        if (fileIds.length > 0) {
          const owned = await tx.select({ id: vendorFiles.id }).from(vendorFiles).where(and(eq(vendorFiles.vendorId, actor.vendorId), inArray(vendorFiles.id, fileIds)));
          if (owned.length !== fileIds.length) throw new ProfileError('FILE', 'One of the files is not available. Please add it again.');
        }
        const rows = input.lines.map((l, i) => {
          const pl = byId.get(l.poLineId);
          if (pl === undefined) throw new ProfileError('INVALID', 'One of the lines is not on this order.', { [`line.${String(i)}.poLineId`]: 'This line is not on the order.' });
          const t = invoiceTotals([{ quantity: l.quantity, unitPrice: l.unitPrice, taxRate: pl.taxRate }]);
          return { invoiceId: id, position: i + 1, poLineId: pl.id, description: pl.description, unit: pl.unit, quantity: l.quantity.trim(), unitPrice: Number(l.unitPrice).toFixed(2), taxRate: pl.taxRate, netAmount: money(t.subtotal), taxAmount: money(t.tax) };
        });
        await tx.delete(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, id));
        if (rows.length > 0) await tx.insert(supplierInvoiceLines).values(rows);
        await tx.delete(supplierInvoiceDeliveryNotes).where(eq(supplierInvoiceDeliveryNotes.invoiceId, id));
        if (input.deliveryNotes.length > 0) {
          await tx.insert(supplierInvoiceDeliveryNotes).values(input.deliveryNotes.map((n) => ({ invoiceId: id, noteNo: n.noteNo.trim(), noteDate: n.noteDate, fileId: n.fileId })));
        }
        const totals = invoiceTotals(rows.map((r) => ({ quantity: r.quantity, unitPrice: r.unitPrice, taxRate: r.taxRate })));
        const out = { subtotal: money(totals.subtotal), taxTotal: money(totals.tax), total: money(totals.total) };
        await tx
          .update(supplierInvoices)
          .set({ vendorInvoiceNo: input.header.vendorInvoiceNo.trim(), invoiceDate: input.header.invoiceDate, dueDate: trimToNull(input.header.dueDate), notes: trimToNull(input.header.notes), declaration: input.header.declaration, invoiceFileId: trimToNull(input.invoiceFileId), ...out, updatedAt: now })
          .where(eq(supplierInvoices.id, id));
        return out;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProfileError('DUPLICATE', 'You already have an invoice with this number.', { vendorInvoiceNo: 'You already have an invoice with this number.' });
      throw error;
    }
  }

  /** Sends the saved invoice. Every rule is checked here again, whatever the screen said. */
  async submit(actor: PortalActor, companyId: string, id: string, now: Date = new Date()): Promise<{ number: string }> {
    this.mayWrite(actor);
    const result = await this.db.transaction(async (tx) => {
      const inv = await this.mine(tx, actor, id, true);
      if (!(VENDOR_EDITABLE as readonly string[]).includes(inv.state)) throw new ProfileError('LOCKED', 'This invoice has already been sent.');
      const [v] = await tx.select({ status: vendors.status, block: vendors.block }).from(vendors).where(eq(vendors.id, actor.vendorId));
      if (v?.status !== 'active' || v.block === 'all') throw new ProfileError('VENDOR_NOT_ACTIVE', 'Your account cannot send invoices at the moment. Please contact us.');
      const problems: Record<string, string> = {};
      const header = { vendorInvoiceNo: inv.vendorInvoiceNo, invoiceDate: inv.invoiceDate, dueDate: inv.dueDate ?? '', notes: inv.notes ?? '', declaration: inv.declaration };
      Object.assign(problems, checkInvoiceHeader(header, businessDate(now)));
      if (!inv.declaration) problems.declaration = 'Confirm that this invoice is for goods and services delivered.';
      if (inv.invoiceFileId === null) problems.invoiceFile = 'Attach your own invoice (a PDF or a picture).';
      const lines = await tx.select().from(supplierInvoiceLines).where(eq(supplierInvoiceLines.invoiceId, id));
      if (lines.length === 0) problems.lines = 'Add at least one line.';
      const notes = await tx.select({ id: supplierInvoiceDeliveryNotes.id }).from(supplierInvoiceDeliveryNotes).where(eq(supplierInvoiceDeliveryNotes.invoiceId, id));
      const [po] = await tx.select().from(purchaseOrders).where(eq(purchaseOrders.id, inv.poId));
      const cover = await this.advances.hasCover(inv.poId);
      const rule = deliveryNoteRule({ deliveryNotes: notes.length, orders: [{ number: po?.number ?? '', flagged: po?.requiresAdvancePayment ?? false, cover: cover.ok }] });
      if (!rule.ok) problems.notes = rule.reason;
      const rooms = await roomsFor(tx, inv.poId, id);
      for (const l of lines) {
        const room = rooms.get(l.poLineId);
        const allowed = rule.advance ? (room?.advanceRoom ?? 0) : (room?.goodsRoom ?? 0);
        if (round3(Number(l.quantity)) > allowed) {
          problems[`line.${String(l.position - 1)}.quantity`] = rule.advance ? `Only ${String(allowed)} of this line is left to invoice.` : `Only ${String(allowed)} of this line have been received and not invoiced yet.`;
        }
      }
      if (Number(inv.total) <= 0) problems.lines = 'The invoice total must be above zero.';
      if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', 'The invoice cannot be sent yet. Please correct the highlighted fields.', problems);
      let number = inv.number;
      number ??= (await this.numbering.assign('supplier_invoice', { companyId, branchId: null, date: businessDate(now), document: { kind: 'supplier_invoice', id } }, tx)).number;
      const fromReturned = inv.state === 'returned';
      await tx
        .update(supplierInvoices)
        .set({ state: 'submitted', number, submittedAt: now, firstActionAt: null, advanceBasis: rule.advance, revision: fromReturned ? inv.revision + 1 : inv.revision, returnReasonCode: null, returnNote: null, updatedAt: now })
        .where(eq(supplierInvoices.id, id));
      await writeEvent(tx, actorOf(actor), id, 'submitted', inv.state, 'submitted', { data: { number, revision: fromReturned ? inv.revision + 1 : inv.revision, total: inv.total } });
      return { number, vendorId: inv.vendorId };
    });
    await this.notify?.invoiceSubmitted(result.vendorId, result.number);
    return { number: result.number };
  }

  /** Takes the invoice back, only while nobody on our side has acted on it. The check and the change are one statement. */
  async recall(actor: PortalActor, id: string, now: Date = new Date()): Promise<void> {
    this.mayWrite(actor);
    await this.db.transaction(async (tx) => {
      const inv = await this.mine(tx, actor, id);
      const back = await tx
        .update(supplierInvoices)
        .set({ state: 'draft', submittedAt: null, updatedAt: now })
        .where(and(eq(supplierInvoices.id, id), eq(supplierInvoices.vendorId, actor.vendorId), eq(supplierInvoices.state, 'submitted'), sql`${supplierInvoices.firstActionAt} IS NULL`))
        .returning({ id: supplierInvoices.id });
      if (back.length === 0) {
        throw new ProfileError('TOO_LATE', inv.state === 'draft' ? 'This invoice is already a draft.' : 'Our team has already started on this invoice, so it cannot be taken back now. Ask us to return it and you can correct it.');
      }
      await writeEvent(tx, actorOf(actor), id, 'recalled', 'submitted', 'draft', { data: { number: inv.number } });
    });
  }

  /** Drops a draft or returned invoice. It stays on record and its number can be used again. */
  async close(actor: PortalActor, id: string, reason: string, now: Date = new Date()): Promise<void> {
    this.mayWrite(actor);
    const text = trimToNull(reason);
    if (!has(text)) throw new ProfileError('NOTE_REQUIRED', 'Say why you are closing this invoice.', { reason: 'Say why.' });
    await this.db.transaction(async (tx) => {
      const inv = await this.mine(tx, actor, id, true);
      if (!(VENDOR_EDITABLE as readonly string[]).includes(inv.state)) throw new ProfileError('LOCKED', 'Only an invoice that is still yours to edit can be closed.');
      await tx.update(supplierInvoices).set({ state: 'closed', closeReason: text.slice(0, 500), updatedAt: now }).where(eq(supplierInvoices.id, id));
      await writeEvent(tx, actorOf(actor), id, 'closed', inv.state, 'closed', { reason: text.slice(0, 500) });
    });
  }
}


