import { and, asc, desc, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { purchaseInvoices, vendorCreditMemoEvents, vendorCreditMemoLines, vendorCreditMemos, vendorFiles, vendors, type VendorCreditMemoRow } from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import {
  CREDIT_STATE,
  CREDIT_VENDOR_EDITABLE,
  canRecallCredit,
  checkCreditHeader,
  checkCreditLine,
  creditAmounts,
  creditTotals,
  type CreditHeaderForm,
  type CreditLineForm,
  type CreditState,
} from '@/lib/vendor-credit-memo';
import { reasonLabel } from '@/lib/supplier-invoice';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { originalLines, writeMemoEvent, type Actor, type Tx } from './credit-memo-support';
import { FileRejected, type VendorFileStore } from './file-store';
import type { VendorNotifier } from './notifier';
import { ProfileError, type PortalActor } from './profile-service';

const WRITERS = ['owner', 'finance'];
const actorOf = (a: PortalActor): Actor => ({ type: 'user', id: `vendor:${a.userId}` });
const money = (c: number): string => (c / 100).toFixed(2);

/**
 * The vendor's side of credit notes (design doc §12.3): pick a booked invoice, say which lines are credited and why, attach the
 * credit note, send it, take it back while nobody has touched it, correct and resend what was returned. Totals are worked out here.
 */
export class CreditMemoPortalService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly files: VendorFileStore,
    private readonly notify?: VendorNotifier,
  ) {}

  private mayWrite(actor: PortalActor): void {
    if (!WRITERS.includes(actor.portalRole)) throw new ProfileError('NOT_ALLOWED', 'Only the owner or the finance person can prepare or send credit notes.');
  }

  private async mine(tx: Tx | DrizzleDb, actor: PortalActor, id: string, lock = false): Promise<VendorCreditMemoRow> {
    const q = tx.select().from(vendorCreditMemos).where(and(eq(vendorCreditMemos.id, id), eq(vendorCreditMemos.vendorId, actor.vendorId)));
    const [row] = lock ? await q.for('update') : await q;
    if (row === undefined) throw new ProfileError('NOT_FOUND', 'That credit note does not exist.');
    return row;
  }

  /** The vendor's booked invoices, newest first: what a credit note can be made for. */
  async invoices(vendorId: string) {
    const rows = await this.db.select().from(purchaseInvoices).where(eq(purchaseInvoices.vendorId, vendorId)).orderBy(desc(purchaseInvoices.postedAt)).limit(100);
    return rows.map((r) => ({ id: r.id, number: r.number, vendorInvoiceNo: r.vendorInvoiceNo, invoiceDate: r.invoiceDate, total: r.total, currency: r.currency }));
  }

  async list(vendorId: string, before: { createdAt: string; id: string } | null = null, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const found = await this.db
      .select({ m: vendorCreditMemos, invoiceNo: purchaseInvoices.vendorInvoiceNo, stamp: sql<string>`${vendorCreditMemos.createdAt}::text` })
      .from(vendorCreditMemos)
      .innerJoin(purchaseInvoices, eq(purchaseInvoices.id, vendorCreditMemos.invoiceId))
      .where(and(eq(vendorCreditMemos.vendorId, vendorId), before === null ? undefined : sql`(${vendorCreditMemos.createdAt}::text, ${vendorCreditMemos.id}::text) < (${before.createdAt}, ${before.id})`))
      .orderBy(desc(vendorCreditMemos.createdAt), desc(vendorCreditMemos.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const last = page.at(-1);
    return {
      rows: page.map((x) => ({ id: x.m.id, number: x.m.number, vendorCreditNo: x.m.vendorCreditNo, state: x.m.state, invoiceNo: x.invoiceNo, total: x.m.total, currency: x.m.currency, needsAction: x.m.state === 'returned' })),
      next: found.length > take && last !== undefined ? { createdAt: last.stamp, id: last.m.id } : null,
    };
  }

  async start(actor: PortalActor, companyId: string, input: { purchaseInvoiceId: string; vendorCreditNo: string }, now: Date = new Date()): Promise<{ id: string }> {
    this.mayWrite(actor);
    const no = input.vendorCreditNo.trim();
    if (no === '' || no.length > 40) throw new ProfileError('INVALID', 'Enter the number printed on your credit note (40 characters at most).', { vendorCreditNo: 'Enter the number printed on your credit note.' });
    const [inv] = await this.db.select().from(purchaseInvoices).where(and(eq(purchaseInvoices.id, input.purchaseInvoiceId), eq(purchaseInvoices.vendorId, actor.vendorId)));
    if (inv === undefined) throw new ProfileError('NOT_FOUND', 'That invoice cannot be credited. It may not be booked yet.');
    try {
      return await this.db.transaction(async (tx) => {
        const [made] = await tx
          .insert(vendorCreditMemos)
          .values({ companyId, vendorId: actor.vendorId, invoiceId: inv.id, vendorCreditNo: no, currency: inv.currency, creditDate: businessDate(now), createdByPortalUser: actor.userId })
          .returning({ id: vendorCreditMemos.id });
        if (made === undefined) throw new ProfileError('FAILED', 'The credit note could not be started.');
        await writeMemoEvent(tx, actorOf(actor), made.id, 'created', null, 'draft', { data: { invoice: inv.vendorInvoiceNo } });
        return { id: made.id };
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProfileError('DUPLICATE', 'You already have a credit note with this number.', { vendorCreditNo: 'You already have a credit note with this number.' });
      throw error;
    }
  }

  async load(actor: PortalActor, id: string) {
    const m = await this.mine(this.db, actor, id);
    const [inv, lines, events, file] = await Promise.all([
      this.db.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, m.invoiceId)).then((r) => r[0]),
      this.db.select().from(vendorCreditMemoLines).where(eq(vendorCreditMemoLines.memoId, id)).orderBy(asc(vendorCreditMemoLines.position)),
      this.db.select().from(vendorCreditMemoEvents).where(eq(vendorCreditMemoEvents.memoId, id)).orderBy(asc(vendorCreditMemoEvents.id)),
      m.fileId === null ? Promise.resolve(undefined) : this.db.select({ id: vendorFiles.id, name: vendorFiles.fileName }).from(vendorFiles).where(eq(vendorFiles.id, m.fileId)).then((r) => r[0]),
    ]);
    const originals = await originalLines(this.db, m.invoiceId, id);
    const editable = (CREDIT_VENDOR_EDITABLE as readonly string[]).includes(m.state);
    return {
      id: m.id,
      number: m.number,
      vendorCreditNo: m.vendorCreditNo,
      state: m.state,
      stateLabel: CREDIT_STATE[m.state].label,
      stateWords: CREDIT_STATE[m.state].vendorWords,
      revision: m.revision,
      invoiceId: m.invoiceId,
      invoiceNo: inv?.vendorInvoiceNo ?? '',
      invoiceNumber: inv?.number ?? '',
      currency: m.currency,
      creditDate: m.creditDate,
      reason: m.reason,
      notes: m.notes ?? '',
      subtotal: m.subtotal,
      taxTotal: m.taxTotal,
      total: m.total,
      file: file === undefined ? null : { id: file.id, name: file.name },
      editable,
      canWrite: WRITERS.includes(actor.portalRole),
      canRecall: canRecallCredit(m.state, m.firstActionAt?.toISOString() ?? null),
      returnReason: m.state === 'returned' ? { label: reasonLabel(m.returnReasonCode ?? 'other'), note: m.returnNote ?? '' } : null,
      rejectReason: m.state === 'rejected' ? { label: reasonLabel(m.rejectReasonCode ?? 'other'), note: m.rejectNote ?? '' } : null,
      originals: [...originals.values()].map((o) => ({ id: o.id, description: o.description, quantity: o.quantity, unitPrice: money(o.unitPriceCents), taxRate: o.taxRate, net: money(o.netCents), creditedQuantity: o.creditedQuantity, creditedNet: money(o.creditedNetCents) })),
      lines: lines.map((l) => ({ id: l.id, invoiceLineId: l.invoiceLineId, description: l.description, unit: l.unit, mode: l.mode, quantity: l.quantity, unitPrice: l.unitPrice, netAmount: l.netAmount, taxAmount: l.taxAmount })),
      timeline: events
        .map((e) => ({ event: e.event, at: e.createdAt.toISOString(), note: e.event === 'returned' || e.event === 'rejected' ? (e.reasonText ?? '') : '' }))
        .filter((e) => ['submitted', 'picked_up', 'approved', 'posted', 'returned', 'rejected', 'recalled', 'closed'].includes(e.event)),
    };
  }

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

  async save(actor: PortalActor, id: string, input: { header: CreditHeaderForm; lines: CreditLineForm[]; fileId: string }, now: Date = new Date()): Promise<{ subtotal: string; taxTotal: string; total: string }> {
    this.mayWrite(actor);
    const problems: Record<string, string> = {};
    Object.assign(problems, checkCreditHeader(input.header, businessDate(now)));
    if (new Set(input.lines.map((l) => l.invoiceLineId)).size !== input.lines.length) problems.lines = 'Each invoice line can be credited once on a credit note.';
    try {
      return await this.db.transaction(async (tx) => {
        const m = await this.mine(tx, actor, id, true);
        if (!(CREDIT_VENDOR_EDITABLE as readonly string[]).includes(m.state)) throw new ProfileError('LOCKED', 'This credit note has been sent and cannot be changed now. If it has not been opened yet you can take it back first.');
        const originals = await originalLines(tx, m.invoiceId, id);
        input.lines.forEach((l, i) => {
          for (const [k, v] of Object.entries(checkCreditLine(l, originals.get(l.invoiceLineId)))) problems[`line.${String(i)}.${k}`] = v;
        });
        if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', 'Please correct the highlighted fields.', problems);
        if (has(input.fileId)) {
          const [own] = await tx.select({ id: vendorFiles.id }).from(vendorFiles).where(and(eq(vendorFiles.id, input.fileId), eq(vendorFiles.vendorId, actor.vendorId)));
          if (own === undefined) throw new ProfileError('FILE', 'That file is not available. Please add it again.');
        }
        const rows = input.lines.map((l, i) => {
          const o = originals.get(l.invoiceLineId);
          if (o === undefined) throw new ProfileError('INVALID', 'One of the lines is not on the invoice.');
          const a = creditAmounts(l, o);
          return { memoId: id, position: i + 1, invoiceLineId: o.id, description: o.description, unit: '', mode: l.mode, quantity: String(a.quantity), unitPrice: a.unitPrice, taxRate: String(o.taxRate), netAmount: money(a.netCents), taxAmount: money(a.taxCents), _a: a };
        });
        const units = await tx.select({ id: vendorCreditMemoLines.id }).from(vendorCreditMemoLines).where(eq(vendorCreditMemoLines.memoId, id));
        if (units.length > 0) await tx.delete(vendorCreditMemoLines).where(eq(vendorCreditMemoLines.memoId, id));
        const unitOf = await this.unitsOf(tx, m.invoiceId);
        if (rows.length > 0) await tx.insert(vendorCreditMemoLines).values(rows.map(({ _a, ...r }) => ({ ...r, unit: unitOf.get(r.invoiceLineId) ?? '' })));
        const totals = creditTotals(rows.map((r) => r._a));
        const out = { subtotal: money(totals.subtotal), taxTotal: money(totals.tax), total: money(totals.total) };
        await tx
          .update(vendorCreditMemos)
          .set({ vendorCreditNo: input.header.vendorCreditNo.trim(), creditDate: input.header.creditDate, reason: input.header.reason.trim(), notes: trimToNull(input.header.notes), fileId: trimToNull(input.fileId), ...out, updatedAt: now })
          .where(eq(vendorCreditMemos.id, id));
        return out;
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new ProfileError('DUPLICATE', 'You already have a credit note with this number.', { vendorCreditNo: 'You already have a credit note with this number.' });
      throw error;
    }
  }

  private async unitsOf(tx: Tx | DrizzleDb, purchaseInvoiceId: string): Promise<Map<string, string>> {
    const originals = await tx.execute<{ id: string; unit: string }>(sql`SELECT l.id::text AS id, l.unit FROM supplier_invoice_lines l JOIN purchase_invoices p ON p.supplier_invoice_id = l.invoice_id WHERE p.id = ${purchaseInvoiceId}::uuid`);
    return new Map([...originals].map((r) => [r.id, r.unit]));
  }

  async submit(actor: PortalActor, companyId: string, id: string, now: Date = new Date()): Promise<{ number: string }> {
    this.mayWrite(actor);
    const done = await this.db.transaction(async (tx) => {
      const m = await this.mine(tx, actor, id, true);
      if (!(CREDIT_VENDOR_EDITABLE as readonly string[]).includes(m.state)) throw new ProfileError('LOCKED', 'This credit note has already been sent.');
      const [v] = await tx.select({ status: vendors.status, block: vendors.block }).from(vendors).where(eq(vendors.id, actor.vendorId));
      if (v?.status !== 'active' || v.block === 'all') throw new ProfileError('VENDOR_NOT_ACTIVE', 'Your account cannot send credit notes at the moment. Please contact us.');
      const problems: Record<string, string> = {};
      Object.assign(problems, checkCreditHeader({ vendorCreditNo: m.vendorCreditNo, creditDate: m.creditDate, reason: m.reason, notes: m.notes ?? '' }, businessDate(now)));
      if (m.fileId === null) problems.file = 'Attach your own credit note (a PDF or a picture).';
      const lines = await tx.select({ id: vendorCreditMemoLines.id }).from(vendorCreditMemoLines).where(eq(vendorCreditMemoLines.memoId, id));
      if (lines.length === 0) problems.lines = 'Add at least one line.';
      if (Number(m.total) <= 0) problems.lines = 'The credit note must be for more than zero.';
      // Other credit memos may have taken part of the invoice since this one was saved.
      const originals = await originalLines(tx, m.invoiceId, id);
      const rows = await tx.select().from(vendorCreditMemoLines).where(eq(vendorCreditMemoLines.memoId, id)).orderBy(asc(vendorCreditMemoLines.position));
      rows.forEach((l, i) => {
        const form: CreditLineForm = { invoiceLineId: l.invoiceLineId, mode: l.mode, quantity: l.mode === 'quantity' ? l.quantity : '', unitPrice: l.mode === 'price' ? l.unitPrice : '' };
        for (const [k, msg] of Object.entries(checkCreditLine(form, originals.get(l.invoiceLineId)))) problems[`line.${String(i)}.${k}`] = msg;
      });
      if (Object.keys(problems).length > 0) throw new ProfileError('INVALID', 'The credit note cannot be sent yet. Please correct the highlighted fields.', problems);
      let number = m.number;
      number ??= (await this.numbering.assign('vendor_credit_memo', { companyId, branchId: null, date: businessDate(now), document: { kind: 'vendor_credit_memo', id } }, tx)).number;
      const fromReturned = m.state === 'returned';
      await tx.update(vendorCreditMemos).set({ state: 'submitted', number, submittedAt: now, firstActionAt: null, assignedTo: null, revision: fromReturned ? m.revision + 1 : m.revision, returnReasonCode: null, returnNote: null, updatedAt: now }).where(eq(vendorCreditMemos.id, id));
      await writeMemoEvent(tx, actorOf(actor), id, 'submitted', m.state, 'submitted', { data: { number, total: m.total, revision: fromReturned ? m.revision + 1 : m.revision } });
      return { number };
    });
    await this.notify?.creditSubmitted(actor.vendorId, done.number);
    return done;
  }

  async recall(actor: PortalActor, id: string, now: Date = new Date()): Promise<void> {
    this.mayWrite(actor);
    await this.db.transaction(async (tx) => {
      const m = await this.mine(tx, actor, id);
      const back = await tx
        .update(vendorCreditMemos)
        .set({ state: 'draft', submittedAt: null, updatedAt: now })
        .where(and(eq(vendorCreditMemos.id, id), eq(vendorCreditMemos.vendorId, actor.vendorId), eq(vendorCreditMemos.state, 'submitted'), sql`${vendorCreditMemos.firstActionAt} IS NULL`))
        .returning({ id: vendorCreditMemos.id });
      if (back.length === 0) throw new ProfileError('TOO_LATE', m.state === 'draft' ? 'This credit note is already a draft.' : 'Our team has already started on this credit note, so it cannot be taken back now. Ask us to return it and you can correct it.');
      await writeMemoEvent(tx, actorOf(actor), id, 'recalled', 'submitted', 'draft', { data: { number: m.number } });
    });
  }

  async close(actor: PortalActor, id: string, reason: string, now: Date = new Date()): Promise<void> {
    this.mayWrite(actor);
    const text = trimToNull(reason);
    if (!has(text)) throw new ProfileError('NOTE_REQUIRED', 'Say why you are closing this credit note.', { reason: 'Say why.' });
    await this.db.transaction(async (tx) => {
      const m = await this.mine(tx, actor, id, true);
      if (!(CREDIT_VENDOR_EDITABLE as readonly string[]).includes(m.state)) throw new ProfileError('LOCKED', 'Only a credit note that is still yours to edit can be closed.');
      await tx.update(vendorCreditMemos).set({ state: 'closed', closeReason: text.slice(0, 500), updatedAt: now }).where(eq(vendorCreditMemos.id, id));
      await writeMemoEvent(tx, actorOf(actor), id, 'closed', m.state, 'closed', { reason: text.slice(0, 500) });
    });
  }
}

export type { CreditState };
