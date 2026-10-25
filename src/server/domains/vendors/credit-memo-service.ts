import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  financeSettings,
  purchaseInvoices,
  purchaseOrderLines,
  purchaseOrders,
  rgnLines,
  supplierInvoiceLineRgn,
  supplierInvoiceLines,
  supplierInvoices,
  users,
  vendorCreditMemoEvents,
  vendorCreditMemoLines,
  vendorCreditMemos,
  vendorFiles,
  vendorLedgerEntries,
  vendorPostingGroups,
  vendorSettings,
  vendors,
  type VendorCreditMemoRow,
  type VendorCreditMemoState,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { CREDIT_IN_QUEUE, CREDIT_STAFF_RETURNABLE, takeBackFromLinks } from '@/lib/vendor-credit-memo';
import { INVOICE_REASONS, postingPlan, reasonLabel, type PostingLine } from '@/lib/supplier-invoice';
import { approvalRefusal, fromCents, toCents } from '@/lib/vendor-payment';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { PostingEngine } from '@/server/domains/finance/engine';
import type { PostingSetupService } from '@/server/domains/finance/posting-setup-service';
import type { VendorLedgerService } from '@/server/domains/finance/payables/vendor-ledger-service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import { originalLines, writeMemoEvent, type Tx } from './credit-memo-support';
import type { VendorNotifier } from './notifier';

const ENGINE = { canPostSoftClosed: false, canPostControlAccounts: true };
const MAX_NOTE = 500;

/**
 * The staff side of vendor credit notes (design doc §12.3): pick one up, check it against the invoice it corrects, approve it (never
 * the person who took it), or send it back or refuse it with a reason; then book it. Booking reduces what is owed to the vendor,
 * reverses what the invoice booked for the lines credited, and, for a credited quantity, makes those goods uninvoiced again so a
 * corrected invoice can follow.
 */
export class CreditMemoService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly engine: PostingEngine,
    private readonly setup: PostingSetupService,
    private readonly ledger: VendorLedgerService,
    private readonly notify?: VendorNotifier,
  ) {}

  private async lock(tx: Tx, companyId: string, id: string): Promise<VendorCreditMemoRow> {
    const [m] = await tx.select().from(vendorCreditMemos).where(and(eq(vendorCreditMemos.companyId, companyId), eq(vendorCreditMemos.id, id))).for('update');
    if (m === undefined || m.state === 'draft') throw new FinanceError('NOT_FOUND', 'That credit memo does not exist.');
    return m;
  }

  private async names(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const clean = [...new Set(ids.filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    if (clean.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, clean));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async queue(companyId: string, f: { state?: string; before?: { stamp: string; id: string } | null }, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const stamp = sql<string>`COALESCE(${vendorCreditMemos.submittedAt}, ${vendorCreditMemos.createdAt})::text`;
    const state = has(f.state) && f.state !== 'draft' ? (f.state as VendorCreditMemoState) : null;
    const found = await this.db
      .select({ m: vendorCreditMemos, vendorName: vendors.legalName, invoiceNo: purchaseInvoices.vendorInvoiceNo, stamp })
      .from(vendorCreditMemos)
      .innerJoin(vendors, eq(vendors.id, vendorCreditMemos.vendorId))
      .innerJoin(purchaseInvoices, eq(purchaseInvoices.id, vendorCreditMemos.invoiceId))
      .where(and(
        eq(vendorCreditMemos.companyId, companyId),
        state === null ? inArray(vendorCreditMemos.state, [...CREDIT_IN_QUEUE]) : eq(vendorCreditMemos.state, state),
        f.before === undefined || f.before === null ? undefined : sql`(COALESCE(${vendorCreditMemos.submittedAt}, ${vendorCreditMemos.createdAt})::text, ${vendorCreditMemos.id}::text) < (${f.before.stamp}, ${f.before.id})`,
      ))
      .orderBy(sql`COALESCE(${vendorCreditMemos.submittedAt}, ${vendorCreditMemos.createdAt}) DESC`, desc(vendorCreditMemos.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const last = page.at(-1);
    return {
      rows: page.map((x) => ({ id: x.m.id, number: x.m.number, vendorCreditNo: x.m.vendorCreditNo, state: x.m.state, vendorName: x.vendorName, invoiceNo: x.invoiceNo, total: x.m.total, currency: x.m.currency, submittedAt: x.m.submittedAt?.toISOString() ?? null, revision: x.m.revision })),
      next: found.length > take && last !== undefined ? { stamp: last.stamp, id: last.m.id } : null,
    };
  }

  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ m: vendorCreditMemos, vendorName: vendors.legalName, inv: purchaseInvoices })
      .from(vendorCreditMemos)
      .innerJoin(vendors, eq(vendors.id, vendorCreditMemos.vendorId))
      .innerJoin(purchaseInvoices, eq(purchaseInvoices.id, vendorCreditMemos.invoiceId))
      .where(and(eq(vendorCreditMemos.companyId, companyId), eq(vendorCreditMemos.id, id)));
    if (head === undefined || head.m.state === 'draft') return null;
    const m = head.m;
    const [lines, events, file, entry] = await Promise.all([
      this.db.select().from(vendorCreditMemoLines).where(eq(vendorCreditMemoLines.memoId, id)).orderBy(asc(vendorCreditMemoLines.position)),
      this.db.select().from(vendorCreditMemoEvents).where(eq(vendorCreditMemoEvents.memoId, id)).orderBy(desc(vendorCreditMemoEvents.id)).limit(100),
      m.fileId === null ? Promise.resolve(undefined) : this.db.select({ id: vendorFiles.id, name: vendorFiles.fileName }).from(vendorFiles).where(eq(vendorFiles.id, m.fileId)).then((r) => r[0]),
      this.db.select({ remaining: vendorLedgerEntries.remainingAmount }).from(vendorLedgerEntries).where(eq(vendorLedgerEntries.id, head.inv.ledgerEntryId)).then((r) => r[0]),
    ]);
    const originals = await originalLines(this.db, m.invoiceId, id);
    const names = await this.names([m.assignedTo, m.approvedBy, m.postedBy, ...events.map((e) => e.actorId)]);
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? (x.startsWith('vendor:') ? 'The vendor' : 'Someone')));
    return {
      memo: { ...m, createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(), submittedAt: m.submittedAt?.toISOString() ?? null, firstActionAt: m.firstActionAt?.toISOString() ?? null, approvedAt: m.approvedAt?.toISOString() ?? null, postedAt: m.postedAt?.toISOString() ?? null },
      vendorName: head.vendorName,
      invoice: { id: head.inv.id, number: head.inv.number, vendorInvoiceNo: head.inv.vendorInvoiceNo, total: head.inv.total, open: entry?.remaining ?? '0', currency: head.inv.currency },
      file: file ?? null,
      assignedName: who(m.assignedTo),
      approvedName: who(m.approvedBy),
      lines: lines.map((l) => {
        const o = originals.get(l.invoiceLineId);
        return { id: l.id, position: l.position, description: l.description, unit: l.unit, mode: l.mode, quantity: l.quantity, unitPrice: l.unitPrice, netAmount: l.netAmount, taxAmount: l.taxAmount, billedQuantity: o === undefined ? '' : String(o.quantity), billedPrice: o === undefined ? '' : (o.unitPriceCents / 100).toFixed(2), billedNet: o === undefined ? '' : (o.netCents / 100).toFixed(2) };
      }),
      events: events.map((e) => ({ id: e.id, event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }

  async pickUp(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const m = await this.lock(tx, ctx.companyId, id);
      if (m.state !== 'submitted') throw new FinanceError('WRONG_STATE', m.state === 'received' ? 'Someone has already picked this credit memo up.' : 'This credit memo is not waiting in the queue.');
      await tx.update(vendorCreditMemos).set({ state: 'received', assignedTo: ctx.actor.id, firstActionAt: now, updatedAt: now }).where(eq(vendorCreditMemos.id, id));
      await writeMemoEvent(tx, ctx.actor, id, 'picked_up', 'submitted', 'received');
    });
  }

  async approve(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const m = await this.lock(tx, ctx.companyId, id);
      if (m.state !== 'received') throw new FinanceError('WRONG_STATE', 'Only a credit memo that has been picked up can be approved.');
      const refusal = approvalRefusal(ctx.actor.id ?? '', m.assignedTo);
      if (refusal !== null) throw new FinanceError('FOUR_EYES', 'You picked this credit memo up, so another person has to approve it.');
      await tx.update(vendorCreditMemos).set({ state: 'approved', approvedBy: ctx.actor.id, approvedAt: now, updatedAt: now }).where(eq(vendorCreditMemos.id, id));
      await writeMemoEvent(tx, ctx.actor, id, 'approved', 'received', 'approved');
    });
  }

  async returnToVendor(ctx: FinanceContext, id: string, reasonCode: string, note: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(note);
    if (!INVOICE_REASONS.some((r) => r.code === reasonCode)) throw new FinanceError('INVALID', 'Choose a reason.');
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say what the vendor has to fix.');
    const done = await this.db.transaction(async (tx) => {
      const m = await this.lock(tx, ctx.companyId, id);
      if (!(CREDIT_STAFF_RETURNABLE as readonly string[]).includes(m.state)) throw new FinanceError('WRONG_STATE', m.state === 'posted' ? 'A booked credit memo cannot be returned.' : 'This credit memo cannot be returned at this stage.');
      await tx.update(vendorCreditMemos).set({ state: 'returned', returnReasonCode: reasonCode, returnNote: text.slice(0, MAX_NOTE), assignedTo: null, approvedBy: null, approvedAt: null, updatedAt: now }).where(eq(vendorCreditMemos.id, id));
      await writeMemoEvent(tx, ctx.actor, id, 'returned', m.state, 'returned', { reason: text.slice(0, MAX_NOTE), data: { reasonCode } });
      return m;
    });
    await this.notify?.creditReturned(done.vendorId, done.number ?? '', reasonLabel(reasonCode), text.slice(0, MAX_NOTE));
  }

  async reject(ctx: FinanceContext, id: string, reasonCode: string, note: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(note);
    if (!INVOICE_REASONS.some((r) => r.code === reasonCode)) throw new FinanceError('INVALID', 'Choose a reason.');
    if (reasonCode === 'other' && !has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the credit memo is refused.');
    const done = await this.db.transaction(async (tx) => {
      const m = await this.lock(tx, ctx.companyId, id);
      if (!(CREDIT_STAFF_RETURNABLE as readonly string[]).includes(m.state) && m.state !== 'submitted') throw new FinanceError('WRONG_STATE', 'This credit memo cannot be refused at this stage.');
      await tx.update(vendorCreditMemos).set({ state: 'rejected', rejectReasonCode: reasonCode, rejectNote: text?.slice(0, MAX_NOTE) ?? null, updatedAt: now }).where(eq(vendorCreditMemos.id, id));
      await writeMemoEvent(tx, ctx.actor, id, 'rejected', m.state, 'rejected', { reason: text?.slice(0, MAX_NOTE) ?? null, data: { reasonCode } });
      return m;
    });
    await this.notify?.creditRefused(done.vendorId, done.number ?? '', reasonLabel(reasonCode), text?.slice(0, MAX_NOTE) ?? '');
  }

  async openFile(ctx: FinanceContext, fileId: string) {
    const [m] = await this.db.select({ id: vendorCreditMemos.id }).from(vendorCreditMemos).where(and(eq(vendorCreditMemos.companyId, ctx.companyId), eq(vendorCreditMemos.fileId, fileId)));
    if (m === undefined) return null;
    const [f] = await this.db.select({ fileName: vendorFiles.fileName, mime: vendorFiles.mime, data: vendorFiles.data }).from(vendorFiles).where(eq(vendorFiles.id, fileId));
    if (f === undefined) return null;
    await writeMemoEvent(this.db, ctx.actor, m.id, 'file_opened', null, null, { data: { fileId, fileName: f.fileName } });
    return f;
  }

  /** Books an approved credit memo: the journal, the vendor ledger entry set against the invoice, and the goods credited made uninvoiced. */
  async post(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string; registerId: string }> {
    const done = await this.db.transaction(async (tx) => {
      const m = await this.lock(tx, ctx.companyId, id);
      if (m.state === 'posted') throw new FinanceError('ALREADY_POSTED', 'This credit memo has already been booked.');
      if (m.state !== 'approved') throw new FinanceError('WRONG_STATE', 'Only an approved credit memo can be booked.');
      const [inv] = await tx.select().from(purchaseInvoices).where(eq(purchaseInvoices.id, m.invoiceId));
      const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, m.vendorId));
      if (inv === undefined || vendor === undefined || vendor.block === 'all') throw new FinanceError('VENDOR_BLOCKED', 'This vendor is blocked, so its credit memo cannot be booked.');
      if (vendor.postingGroupId === null) throw new FinanceError('POSTING_GROUP', `${vendor.legalName} has no posting group. Choose one on the vendor’s financial settings first.`);
      const [group] = await tx.select().from(vendorPostingGroups).where(eq(vendorPostingGroups.id, vendor.postingGroupId));
      if (group?.payablesAccountId == null) throw new FinanceError('POSTING_GROUP', 'The vendor’s posting group has no payables account.');
      const [fs] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, ctx.companyId));
      if (fs === undefined) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
      if (m.currency !== fs.baseCurrency) throw new FinanceError('FOREIGN_CURRENCY', `This credit memo is in ${m.currency}. Booking in another currency needs an exchange rate, which is not built yet.`);
      const lines = await tx.select().from(vendorCreditMemoLines).where(eq(vendorCreditMemoLines.memoId, id)).orderBy(asc(vendorCreditMemoLines.position));
      const invLines = await tx.select().from(supplierInvoiceLines).where(inArray(supplierInvoiceLines.id, lines.map((l) => l.invoiceLineId)));
      const poLines = await tx.select().from(purchaseOrderLines).where(inArray(purchaseOrderLines.id, invLines.map((l) => l.poLineId)));
      const byInv = new Map(invLines.map((l) => [l.id, l]));
      const byPo = new Map(poLines.map((l) => [l.id, l]));

      const plan: PostingLine[] = lines.map((l) => {
        const il = byInv.get(l.invoiceLineId);
        const stock = il === undefined ? false : byPo.get(il.poLineId)?.productId != null;
        if (!stock && il?.glAccountId == null) throw new FinanceError('ACCOUNT_MISSING', `Line ${String(l.position)} was booked to no account on the invoice, so it cannot be credited back.`);
        return { kind: stock ? 'stock' : 'account', accountId: il?.glAccountId ?? null, netCents: toCents(l.netAmount) };
      });
      const taxCents = toCents(m.taxTotal);
      const built = postingPlan(plan, taxCents);
      const totalCents = toCents(m.total);
      if (built.payableCents !== totalCents) throw new FinanceError('TOTAL_MISMATCH', 'The lines do not add up to the credit memo total. Return it to the vendor.');
      const date = businessDate(now);
      const [settings] = await tx.select().from(vendorSettings).where(eq(vendorSettings.companyId, ctx.companyId));
      if (taxCents > 0 && (settings?.inputTaxAccountId ?? null) === null) throw new FinanceError('TAX_ACCOUNT_MISSING', 'This credit memo has tax and no input tax account is set. Choose one in the ordering rules.');
      if (built.debits.some((d) => d.purpose === 'inventory_clearing') && fs.inventoryGlGoLive === null) throw new FinanceError('STOCK_NOT_LIVE', 'Stock is not in the books yet, so goods that were received cannot be cleared. Start stock accounting first.');

      const journal: { accountId: string; debit: string; credit: string; description: string; sourceLedger?: string; sourceEntryId?: string }[] = [
        { accountId: group.payablesAccountId, debit: fromCents(totalCents), credit: '0', description: `${vendor.legalName}: credit note ${m.vendorCreditNo}`, sourceLedger: 'vendor', sourceEntryId: vendor.id },
      ];
      for (const d of built.debits) {
        let accountId = d.accountId;
        if (d.purpose === 'inventory_clearing') {
          try {
            accountId = (await this.setup.resolveGeneral(ctx.companyId, fs.defaultBusinessGroup, fs.defaultProductGroup, 'inventory_clearing', date)).accountId;
          } catch (error) {
            throw new FinanceError('POSTING_SETUP_MISSING', error instanceof Error ? error.message : 'Posting setup is incomplete.');
          }
        }
        if (!has(accountId)) throw new FinanceError('ACCOUNT_MISSING', 'A line has no account to be credited.');
        journal.push({ accountId, debit: '0', credit: fromCents(d.cents), description: d.purpose === 'inventory_clearing' ? 'Goods billed, now credited' : 'Supplier credit note' });
      }
      if (taxCents > 0 && settings?.inputTaxAccountId != null) journal.push({ accountId: settings.inputTaxAccountId, debit: '0', credit: fromCents(taxCents), description: 'Input tax credited' });

      // A credited quantity makes those goods uninvoiced again (so a corrected invoice can follow).
      let credited = false;
      for (const l of lines) {
        if (l.mode !== 'quantity') continue;
        const il = byInv.get(l.invoiceLineId);
        if (il === undefined) continue;
        const links = await tx
          .select({ link: supplierInvoiceLineRgn, invoiced: rgnLines.invoicedQuantity })
          .from(supplierInvoiceLineRgn)
          .innerJoin(rgnLines, eq(rgnLines.id, supplierInvoiceLineRgn.rgnLineId))
          .where(eq(supplierInvoiceLineRgn.invoiceLineId, il.id))
          .for('update', { of: rgnLines });
        const back = takeBackFromLinks(Number(l.quantity), links.map((x) => ({ rgnLineId: x.link.rgnLineId, linked: Number(x.link.quantity), invoiced: Number(x.invoiced) })));
        for (const t of back.takes) await tx.update(rgnLines).set({ invoicedQuantity: sql`${rgnLines.invoicedQuantity} - ${String(t.quantity)}::numeric` }).where(eq(rgnLines.id, t.rgnLineId));
        await tx.update(purchaseOrderLines).set({ invoicedQuantity: sql`GREATEST(${purchaseOrderLines.invoicedQuantity} - ${l.quantity}::numeric, 0)` }).where(eq(purchaseOrderLines.id, il.poLineId));
        credited = true;
      }
      if (credited) {
        const [si] = await tx.select({ poId: supplierInvoices.poId }).from(supplierInvoices).where(eq(supplierInvoices.id, inv.supplierInvoiceId));
        if (si !== undefined) {
          const [po] = await tx.select({ status: purchaseOrders.status }).from(purchaseOrders).where(eq(purchaseOrders.id, si.poId)).for('update');
          if (po?.status === 'invoiced') await tx.update(purchaseOrders).set({ status: 'partially_invoiced', updatedAt: now }).where(eq(purchaseOrders.id, si.poId));
        }
      }

      const { registerId } = await this.engine.post(
        {
          companyId: ctx.companyId,
          idempotencyKey: `credit-memo:${id}`,
          postingDate: date,
          documentDate: m.creditDate,
          documentType: 'purchase_credit_memo',
          documentNo: m.number ?? '',
          description: `${vendor.legalName}: credit note ${m.vendorCreditNo} for invoice ${inv.vendorInvoiceNo}`,
          currency: fs.baseCurrency,
          rate: '1',
          rateSource: 'base',
          lines: journal,
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'vendor_credit_memo', id },
          postedBy: 'engine',
        },
        ENGINE,
        tx,
      );
      const entryId = randomUUID();
      await this.ledger.addEntry(tx, { id: entryId, companyId: ctx.companyId, vendorId: vendor.id, documentType: 'credit_memo', documentNo: m.number ?? '', externalDocumentNo: null, documentId: id, description: `Credit note ${m.vendorCreditNo}`, amountCents: -totalCents, currency: m.currency, postingDate: date, documentDate: m.creditDate, registerId, idempotencyKey: `credit-memo:${id}`, createdBy: ctx.actor.id });
      const [invEntry] = await tx.select({ remaining: vendorLedgerEntries.remainingAmount }).from(vendorLedgerEntries).where(eq(vendorLedgerEntries.id, inv.ledgerEntryId)).for('update');
      const cents = Math.min(totalCents, invEntry === undefined ? 0 : toCents(invEntry.remaining));
      if (cents > 0) await this.ledger.apply(tx, { companyId: ctx.companyId, vendorId: vendor.id, creditEntryId: entryId, invoiceEntryId: inv.ledgerEntryId, amountCents: cents, postingDate: date, registerId, createdBy: ctx.actor.id });
      await tx.update(vendorCreditMemos).set({ state: 'posted', postedAt: now, postedBy: ctx.actor.id, registerId, ledgerEntryId: entryId, updatedAt: now }).where(eq(vendorCreditMemos.id, id));
      await writeMemoEvent(tx, ctx.actor, id, 'posted', 'approved', 'posted', { data: { registerId, total: m.total, appliedToInvoice: fromCents(cents) } });
      return { m, number: m.number ?? '', registerId };
    });
    await this.notify?.creditBooked(done.m.vendorId, done.number, done.m.vendorCreditNo, done.m.total, done.m.currency);
    return { number: done.number, registerId: done.registerId };
  }
}
