import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  financeSettings,
  paymentMethods,
  purchaseInvoices,
  purchaseOrders,
  supplierInvoices,
  users,
  vendorAdvancePayments,
  vendorBankAccounts,
  vendorLedgerEntries,
  vendorPaymentEvents,
  vendorPaymentVoucherLines,
  vendorPaymentVouchers,
  vendorPostingGroups,
  vendorSettings,
  vendors,
  type VendorPaymentVoucherRow,
  type VendorVoucherStatus,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import {
  DEFAULT_THREE_EYES_ABOVE_CENTS,
  LIVE_VOUCHER,
  approvalRefusal,
  checkAllocations,
  checkVoucherHeader,
  fromCents,
  needsThreePeople,
  releaseRefusal,
  toCents,
  type AllocationForm,
  type VoucherHeaderForm,
} from '@/lib/vendor-payment';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { PostingEngine } from '@/server/domains/finance/engine';
import type { VendorLedgerService } from '@/server/domains/finance/payables/vendor-ledger-service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { AdvancePaymentService } from './advance-service';
import type { VendorNotifier } from './notifier';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
interface Actor {
  type: 'user' | 'system' | 'job' | 'integration';
  id: string | null;
}
const ENGINE = { canPostSoftClosed: false, canPostControlAccounts: true };
/** Methods that send money to the vendor's bank account; the others (cash, cheque) have no account to freeze. */
const NEEDS_ACCOUNT = ['bank_transfer', 'bank_deposit', 'mobile_money'];

/**
 * Payment vouchers (design doc §12.5): the document that lets money go to one vendor, for booked invoices or for an advance.
 * Three people at the larger values (prepare, approve, pay), the vendor's bank account fixed at approval, nothing paid to a
 * blocked vendor, and one transaction for the journal, the vendor ledger and the applications, so a half-paid voucher cannot exist.
 */
export class VendorPaymentService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly numbering: NumberSeriesService,
    private readonly engine: PostingEngine,
    private readonly ledger: VendorLedgerService,
    private readonly advances: AdvancePaymentService,
    private readonly notify?: VendorNotifier,
  ) {}

  private async event(tx: Tx | DrizzleDb, actor: Actor, voucherId: string, event: string, from: string | null, to: string | null, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(vendorPaymentEvents).values({ voucherId, event, fromStatus: from, toStatus: to, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: actor.type, actorId: actor.id });
  }

  private async lock(tx: Tx, companyId: string, id: string): Promise<VendorPaymentVoucherRow> {
    const [v] = await tx.select().from(vendorPaymentVouchers).where(and(eq(vendorPaymentVouchers.companyId, companyId), eq(vendorPaymentVouchers.id, id))).for('update');
    if (v === undefined) throw new FinanceError('NOT_FOUND', 'That payment voucher does not exist.');
    return v;
  }

  async thresholdCents(db: Tx | DrizzleDb, companyId: string): Promise<number> {
    const [s] = await db.select({ t: vendorSettings.paymentThreeEyesAbove }).from(vendorSettings).where(eq(vendorSettings.companyId, companyId));
    return s === undefined ? DEFAULT_THREE_EYES_ABOVE_CENTS : toCents(s.t);
  }

  /** The value from which a payment needs three people, in cents. */
  async threshold(companyId: string): Promise<number> {
    return await this.thresholdCents(this.db, companyId);
  }

  private async vendorMayBePaid(tx: Tx | DrizzleDb, companyId: string, vendorId: string): Promise<{ legalName: string; postingGroupId: string | null }> {
    const [v] = await tx.select().from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, vendorId)));
    if (v === undefined) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    if (v.block !== 'none') throw new FinanceError('VENDOR_BLOCKED', `${v.legalName} is blocked from payments, so nothing can be paid to it now.`);
    return { legalName: v.legalName, postingGroupId: v.postingGroupId };
  }

  private async method(tx: Tx | DrizzleDb, companyId: string, methodId: string) {
    const [m] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.id, methodId)));
    if (m === undefined || !m.enabled || !m.usableFor.includes('vendor_payment')) throw new FinanceError('METHOD_INVALID', 'Choose a way of paying that is set up for paying vendors.');
    const [bank] = await tx.select().from(bankAccounts).where(eq(bankAccounts.id, m.balancingBankAccountId));
    if (bank === undefined || bank.blocked) throw new FinanceError('METHOD_INVALID', 'The bank account behind that way of paying is blocked.');
    const [fs] = await tx.select({ base: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (fs === undefined) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
    if (bank.currency !== fs.base) throw new FinanceError('FOREIGN_CURRENCY', `That way of paying is in ${bank.currency}. Paying in another currency needs an exchange rate, which is not built yet.`);
    return { method: m, base: fs.base };
  }

  // ── what is open ─────────────────────────────────────────────────────────

  /** The booked invoices of a vendor that still have something to pay, less what other live vouchers already claim. */
  async openItems(companyId: string, vendorId: string, exceptVoucherId: string | null = null) {
    const rows = await this.db
      .select({ p: purchaseInvoices, remaining: vendorLedgerEntries.remainingAmount })
      .from(purchaseInvoices)
      .innerJoin(vendorLedgerEntries, eq(vendorLedgerEntries.id, purchaseInvoices.ledgerEntryId))
      .where(and(eq(purchaseInvoices.companyId, companyId), eq(purchaseInvoices.vendorId, vendorId), sql`${vendorLedgerEntries.remainingAmount} > 0`))
      .orderBy(asc(purchaseInvoices.dueDate), asc(purchaseInvoices.postedAt));
    const held = rows.length === 0 ? [] : await this.db
      .select({ invoiceId: vendorPaymentVoucherLines.purchaseInvoiceId, total: sql<string>`COALESCE(SUM(${vendorPaymentVoucherLines.amount}), 0)::text` })
      .from(vendorPaymentVoucherLines)
      .innerJoin(vendorPaymentVouchers, eq(vendorPaymentVouchers.id, vendorPaymentVoucherLines.voucherId))
      .where(and(inArray(vendorPaymentVoucherLines.purchaseInvoiceId, rows.map((r) => r.p.id)), inArray(vendorPaymentVouchers.status, [...LIVE_VOUCHER]), exceptVoucherId === null ? undefined : ne(vendorPaymentVouchers.id, exceptVoucherId)))
      .groupBy(vendorPaymentVoucherLines.purchaseInvoiceId);
    const heldBy = new Map(held.map((h) => [h.invoiceId, toCents(h.total)]));
    return rows.map((r) => {
      const remainingCents = toCents(r.remaining);
      const heldCents = heldBy.get(r.p.id) ?? 0;
      return { purchaseInvoiceId: r.p.id, number: r.p.number, vendorInvoiceNo: r.p.vendorInvoiceNo, invoiceDate: r.p.invoiceDate, dueDate: r.p.dueDate, total: r.p.total, remaining: r.remaining, held: fromCents(heldCents), availableCents: Math.max(0, remainingCents - heldCents), available: fromCents(Math.max(0, remainingCents - heldCents)) };
    });
  }

  /** Approved advance payments of a vendor that no live voucher is paying yet. */
  async advancesToPay(companyId: string, vendorId: string) {
    const rows = await this.db
      .select({ a: vendorAdvancePayments, poNumber: purchaseOrders.number })
      .from(vendorAdvancePayments)
      .innerJoin(purchaseOrders, eq(purchaseOrders.id, vendorAdvancePayments.poId))
      .where(and(eq(vendorAdvancePayments.companyId, companyId), eq(vendorAdvancePayments.vendorId, vendorId), eq(vendorAdvancePayments.status, 'approved')))
      .orderBy(desc(vendorAdvancePayments.createdAt));
    const taken = rows.length === 0 ? [] : await this.db.select({ advanceId: vendorPaymentVouchers.advanceId }).from(vendorPaymentVouchers).where(and(inArray(vendorPaymentVouchers.advanceId, rows.map((r) => r.a.id)), inArray(vendorPaymentVouchers.status, [...LIVE_VOUCHER])));
    const busy = new Set(taken.map((t) => t.advanceId));
    return rows.filter((r) => !busy.has(r.a.id)).map((r) => ({ id: r.a.id, orderNumber: r.poNumber ?? '', amount: r.a.amount, currency: r.a.currency, reason: r.a.reason }));
  }

  // ── writing ──────────────────────────────────────────────────────────────

  async saveDraft(ctx: FinanceContext, id: string | null, header: VoucherHeaderForm, allocations: AllocationForm[]): Promise<{ id: string; amount: string }> {
    const first = Object.values(checkVoucherHeader(header))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    return await this.db.transaction(async (tx) => {
      await this.vendorMayBePaid(tx, ctx.companyId, header.vendorId);
      const { method, base } = await this.method(tx, ctx.companyId, header.methodId);
      let amountCents: number;
      let lines: { purchaseInvoiceId: string; amount: string }[] = [];
      if (header.kind === 'invoices') {
        const items = await this.openItems(ctx.companyId, header.vendorId, id);
        const checked = checkAllocations(items, allocations);
        const problem = Object.values(checked.problems)[0];
        if (has(problem)) throw new FinanceError('INVALID', problem);
        amountCents = checked.totalCents;
        lines = allocations.map((a) => ({ purchaseInvoiceId: a.purchaseInvoiceId, amount: fromCents(toCents(a.amount)) }));
      } else {
        const [adv] = await tx.select().from(vendorAdvancePayments).where(and(eq(vendorAdvancePayments.companyId, ctx.companyId), eq(vendorAdvancePayments.id, header.advanceId), eq(vendorAdvancePayments.vendorId, header.vendorId)));
        if (adv === undefined) throw new FinanceError('NOT_FOUND', 'That advance payment does not exist for this vendor.');
        if (adv.status !== 'approved') throw new FinanceError('NOT_APPROVED', 'Only an approved advance payment can be paid.');
        if (adv.currency !== base) throw new FinanceError('FOREIGN_CURRENCY', `That advance is in ${adv.currency}. Paying in another currency needs an exchange rate, which is not built yet.`);
        amountCents = toCents(adv.amount);
      }
      if (amountCents <= 0) throw new FinanceError('INVALID', 'The payment must be for more than zero.');
      const values = { vendorId: header.vendorId, kind: header.kind, currency: base, amount: fromCents(amountCents), methodId: method.id, advanceId: header.kind === 'advance' ? header.advanceId : null, narration: trimToNull(header.narration), updatedAt: new Date() };
      let voucherId = id;
      try {
        if (id === null) {
          const [made] = await tx.insert(vendorPaymentVouchers).values({ companyId: ctx.companyId, createdBy: ctx.actor.id, ...values }).returning({ id: vendorPaymentVouchers.id });
          voucherId = made?.id ?? null;
        } else {
          const v = await this.lock(tx, ctx.companyId, id);
          if (v.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be changed. Ask for it to be sent back first.');
          await tx.update(vendorPaymentVouchers).set(values).where(eq(vendorPaymentVouchers.id, id));
          await tx.delete(vendorPaymentVoucherLines).where(eq(vendorPaymentVoucherLines.voucherId, id));
        }
      } catch (error) {
        if ((error as { code?: string; cause?: { code?: string } }).code === '23505' || (error as { cause?: { code?: string } }).cause?.code === '23505') throw new FinanceError('ALREADY_LIVE', 'Another payment voucher is already paying that advance.');
        throw error;
      }
      if (voucherId === null) throw new FinanceError('FAILED', 'The voucher could not be saved.');
      if (lines.length > 0) await tx.insert(vendorPaymentVoucherLines).values(lines.map((l) => ({ voucherId, ...l })));
      if (id === null) await this.event(tx, ctx.actor, voucherId, 'created', null, 'draft', { data: { kind: header.kind, amount: fromCents(amountCents) } });
      return { id: voucherId, amount: fromCents(amountCents) };
    });
  }

  async submit(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<void> {
    await this.db.transaction(async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (v.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft can be sent for approval.');
      await this.vendorMayBePaid(tx, ctx.companyId, v.vendorId);
      if (v.kind === 'invoices') await this.recheckLines(tx, ctx.companyId, v);
      await tx.update(vendorPaymentVouchers).set({ status: 'pending_approval', submittedAt: now, sendBackReason: null, updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
      await this.event(tx, ctx.actor, id, 'submitted', 'draft', 'pending_approval');
    });
  }

  /** Every invoice on the voucher still has at least what the voucher pays open (other live vouchers are already excluded by the claim rule). */
  private async recheckLines(tx: Tx, companyId: string, v: VendorPaymentVoucherRow): Promise<void> {
    const lines = await tx.select().from(vendorPaymentVoucherLines).where(eq(vendorPaymentVoucherLines.voucherId, v.id));
    const items = await this.openItems(companyId, v.vendorId, v.id);
    const checked = checkAllocations(items, lines.map((l) => ({ purchaseInvoiceId: l.purchaseInvoiceId, amount: l.amount })));
    const problem = Object.values(checked.problems)[0];
    if (has(problem)) throw new FinanceError('INVOICE_CHANGED', `An invoice on this voucher changed since it was written: ${problem}`);
  }

  async approve(ctx: FinanceContext, id: string, now: Date = new Date()): Promise<{ number: string }> {
    return await this.db.transaction(async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (v.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This payment voucher is not waiting for approval.');
      const refusal = approvalRefusal(ctx.actor.id ?? '', v.createdBy);
      if (refusal !== null) throw new FinanceError('FOUR_EYES', refusal);
      await this.vendorMayBePaid(tx, ctx.companyId, v.vendorId);
      if (v.kind === 'invoices') await this.recheckLines(tx, ctx.companyId, v);
      const { method } = await this.method(tx, ctx.companyId, v.methodId);
      let accountId: string | null = null;
      let destination: string | null = null;
      if (NEEDS_ACCOUNT.includes(method.kind)) {
        const active = await tx.select().from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, v.vendorId), eq(vendorBankAccounts.status, 'active'))).orderBy(desc(vendorBankAccounts.createdAt));
        const account = active[0];
        if (account === undefined) throw new FinanceError('NO_BANK_ACCOUNT', 'The vendor has no bank account that can receive money. A new or changed account is usable only after it is approved and its waiting period has passed.');
        accountId = account.id;
        destination = `${account.bankName} account ending ${account.accountLast4}`;
      }
      const threshold = await this.thresholdCents(tx, ctx.companyId);
      const three = needsThreePeople(toCents(v.amount), threshold);
      const number = v.number ?? (await this.numbering.assign('vendor_payment', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'vendor_payment', id } }, tx)).number;
      await tx.update(vendorPaymentVouchers).set({ status: 'approved', number, approvedBy: ctx.actor.id, approvedAt: now, needsThree: three, vendorBankAccountId: accountId, destination, updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
      await this.event(tx, ctx.actor, id, 'approved', 'pending_approval', 'approved', { data: { number, needsThree: three, destination } });
      return { number };
    });
  }

  async sendBack(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the payment is sent back.');
    await this.db.transaction(async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (v.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This payment voucher is not waiting for approval.');
      await tx.update(vendorPaymentVouchers).set({ status: 'draft', sendBackReason: text.slice(0, 500), updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
      await this.event(tx, ctx.actor, id, 'sent_back', 'pending_approval', 'draft', { reason: text.slice(0, 500) });
    });
  }

  async cancel(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the payment is cancelled.');
    await this.db.transaction(async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (!(LIVE_VOUCHER as readonly string[]).includes(v.status)) throw new FinanceError('WRONG_STATE', v.status === 'paid' ? 'A paid voucher cannot be cancelled. Reverse it.' : 'This payment voucher is finished.');
      await tx.update(vendorPaymentVouchers).set({ status: 'cancelled', cancelReason: text.slice(0, 500), updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
      await this.event(tx, ctx.actor, id, 'cancelled', v.status, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  /** The money leaves. Everything happens in one transaction or none of it does. */
  async pay(ctx: FinanceContext, id: string, input: { reference: string; paidOn: string }, now: Date = new Date()): Promise<{ number: string; registerId: string }> {
    const reference = trimToNull(input.reference);
    const today = businessDate(now);
    if (!has(reference)) throw new FinanceError('REFERENCE_REQUIRED', 'Enter the reference of the payment: the transfer, cheque or receipt number.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn) || input.paidOn > today) throw new FinanceError('INVALID', 'Enter the date the money was paid, not in the future.');
    const done = await this.db.transaction(async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (v.status !== 'approved') throw new FinanceError('WRONG_STATE', v.status === 'paid' ? 'This voucher has already been paid.' : 'Only an approved voucher can be paid.');
      const refusal = releaseRefusal(ctx.actor.id ?? '', v.createdBy, v.approvedBy, v.needsThree);
      if (refusal !== null) throw new FinanceError('THREE_PEOPLE', refusal);
      const vendor = await this.vendorMayBePaid(tx, ctx.companyId, v.vendorId);
      const { method } = await this.method(tx, ctx.companyId, v.methodId);
      if (v.vendorBankAccountId !== null) {
        const [account] = await tx.select({ status: vendorBankAccounts.status }).from(vendorBankAccounts).where(eq(vendorBankAccounts.id, v.vendorBankAccountId));
        if (account?.status !== 'active') throw new FinanceError('DESTINATION_CHANGED', 'The vendor’s bank account this voucher was approved for is no longer in use. Cancel it and make a new voucher.');
      }
      if (vendor.postingGroupId === null) throw new FinanceError('POSTING_GROUP', `${vendor.legalName} has no posting group. Choose one on the vendor’s financial settings first.`);
      const [group] = await tx.select().from(vendorPostingGroups).where(eq(vendorPostingGroups.id, vendor.postingGroupId));
      const debitAccount = v.kind === 'invoices' ? group?.payablesAccountId : group?.prepaymentsAccountId;
      if (debitAccount === null || debitAccount === undefined) throw new FinanceError('POSTING_GROUP', v.kind === 'invoices' ? 'The vendor’s posting group has no payables account.' : 'The vendor’s posting group has no prepayments account for advances.');
      const lines = await tx.select().from(vendorPaymentVoucherLines).where(eq(vendorPaymentVoucherLines.voucherId, id));
      const invoices = lines.length === 0 ? [] : await tx.select().from(purchaseInvoices).where(inArray(purchaseInvoices.id, lines.map((l) => l.purchaseInvoiceId)));
      const cents = toCents(v.amount);
      const description = v.kind === 'invoices' ? `${vendor.legalName}: payment of ${invoices.map((i) => i.vendorInvoiceNo).join(', ')}` : `${vendor.legalName}: advance payment`;
      const { registerId } = await this.engine.post(
        {
          companyId: ctx.companyId,
          idempotencyKey: `vendor-payment:${id}`,
          postingDate: input.paidOn,
          documentType: 'vendor_payment',
          documentNo: v.number ?? '',
          description,
          currency: v.currency,
          rate: '1',
          rateSource: 'base',
          lines: [
            { accountId: debitAccount, debit: fromCents(cents), credit: '0', description, sourceLedger: 'vendor', sourceEntryId: v.vendorId },
            { accountId: method.glAccountId, debit: '0', credit: fromCents(cents), description: `${method.name} ${reference}` },
          ],
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'vendor_payment', id },
          postedBy: 'engine',
        },
        ENGINE,
        tx,
      );
      const entryId = randomUUID();
      await this.ledger.addEntry(tx, { id: entryId, companyId: ctx.companyId, vendorId: v.vendorId, documentType: v.kind === 'invoices' ? 'payment' : 'advance', documentNo: v.number ?? '', documentId: id, description, amountCents: -cents, currency: v.currency, postingDate: input.paidOn, registerId, idempotencyKey: `vendor-payment:${id}`, createdBy: ctx.actor.id });
      for (const l of lines) {
        const inv = invoices.find((i) => i.id === l.purchaseInvoiceId);
        if (inv === undefined) continue;
        await this.ledger.apply(tx, { companyId: ctx.companyId, vendorId: v.vendorId, creditEntryId: entryId, invoiceEntryId: inv.ledgerEntryId, amountCents: toCents(l.amount), postingDate: input.paidOn, registerId, createdBy: ctx.actor.id });
      }
      if (v.kind === 'advance' && v.advanceId !== null) await this.advances.payIn(tx, ctx.companyId, v.advanceId, id, now);
      await tx.update(vendorPaymentVouchers).set({ status: 'paid', paidBy: ctx.actor.id, paidAt: now, paidOn: input.paidOn, paymentReference: reference.slice(0, 120), registerId, ledgerEntryId: entryId, updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
      await this.event(tx, ctx.actor, id, 'paid', 'approved', 'paid', { data: { reference, paidOn: input.paidOn, registerId } });
      return { v, vendorId: v.vendorId, number: v.number ?? '', registerId, invoiceNos: invoices.map((i) => i.vendorInvoiceNo) };
    });
    await this.notify?.paymentMade(done.vendorId, done.number, done.v.amount, done.v.currency, reference, done.invoiceNos);
    return { number: done.number, registerId: done.registerId };
  }

  /** A mistake in a paid voucher: the journal is reversed, the applications are undone, the invoices are open again. */
  async reverse(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the payment is reversed.');
    await this.db.transaction(async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (v.status !== 'paid' || v.registerId === null || v.ledgerEntryId === null) throw new FinanceError('NOT_PAID', 'Only a paid voucher can be reversed.');
      const today = businessDate(now);
      if (v.kind === 'advance') {
        const [entry] = await tx.select({ open: vendorLedgerEntries.remainingAmount, amount: vendorLedgerEntries.amount }).from(vendorLedgerEntries).where(eq(vendorLedgerEntries.id, v.ledgerEntryId));
        if (entry !== undefined && toCents(entry.open) !== toCents(entry.amount)) throw new FinanceError('ADVANCE_APPLIED', 'Part of this advance was already set against an invoice. Undo that first.');
        if (v.advanceId !== null) await this.advances.reopenIn(tx, ctx.companyId, v.advanceId, now);
      }
      await this.ledger.unapplyAll(tx, { companyId: ctx.companyId, entryId: v.ledgerEntryId, postingDate: today, reasonText: text.slice(0, 500), createdBy: ctx.actor.id });
      const reversal = await this.engine.reverse({ companyId: ctx.companyId, registerId: v.registerId, postingDate: today, reasonCode: 'vendor_payment_reversed', reasonText: text.slice(0, 500), origin: ctx.origin, permissions: ENGINE, tx });
      await this.ledger.reverseEntry(tx, { companyId: ctx.companyId, entryId: v.ledgerEntryId, postingDate: today, reasonText: text.slice(0, 500), registerId: reversal.registerId, createdBy: ctx.actor.id });
      await tx.update(vendorPaymentVouchers).set({ status: 'reversed', reversedBy: ctx.actor.id, reversedAt: now, reverseReason: text.slice(0, 500), reversalRegisterId: reversal.registerId, updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
      await this.event(tx, ctx.actor, id, 'reversed', 'paid', 'reversed', { reason: text.slice(0, 500), data: { reversalRegisterId: reversal.registerId } });
    });
  }

  /** Sets a paid advance against a booked invoice of the same order: Dr payables, Cr prepayments, and the ledger entries applied. */
  async applyAdvance(ctx: FinanceContext, purchaseInvoiceId: string, now: Date = new Date()): Promise<{ appliedCents: number }> {
    return await this.db.transaction(async (tx) => {
      const [inv] = await tx
        .select({ p: purchaseInvoices, poId: supplierInvoices.poId })
        .from(purchaseInvoices)
        .innerJoin(supplierInvoices, eq(supplierInvoices.id, purchaseInvoices.supplierInvoiceId))
        .where(and(eq(purchaseInvoices.companyId, ctx.companyId), eq(purchaseInvoices.id, purchaseInvoiceId)));
      if (inv === undefined) throw new FinanceError('NOT_FOUND', 'That booked invoice does not exist.');
      const [adv] = await tx.select().from(vendorAdvancePayments).where(and(eq(vendorAdvancePayments.poId, inv.poId), eq(vendorAdvancePayments.status, 'paid')));
      if (adv === undefined || adv.voucherId === null) throw new FinanceError('NO_ADVANCE', 'There is no paid advance on this invoice’s order to set against it.');
      const [voucher] = await tx.select().from(vendorPaymentVouchers).where(eq(vendorPaymentVouchers.id, adv.voucherId));
      if (voucher?.ledgerEntryId == null) throw new FinanceError('NO_ADVANCE', 'The advance has no ledger entry.');
      const [advEntry] = await tx.select().from(vendorLedgerEntries).where(eq(vendorLedgerEntries.id, voucher.ledgerEntryId)).for('update');
      const [invEntry] = await tx.select().from(vendorLedgerEntries).where(eq(vendorLedgerEntries.id, inv.p.ledgerEntryId)).for('update');
      if (advEntry === undefined || invEntry === undefined) throw new FinanceError('NOT_FOUND', 'The ledger entries are missing.');
      const advOpen = -toCents(advEntry.remainingAmount);
      const invOpen = toCents(invEntry.remainingAmount);
      const cents = Math.min(advOpen, invOpen);
      if (cents <= 0) throw new FinanceError('NOTHING_TO_APPLY', 'The advance has nothing left to apply, or the invoice has nothing left to pay.');
      const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, inv.p.vendorId));
      const [group] = vendor?.postingGroupId == null ? [] : await tx.select().from(vendorPostingGroups).where(eq(vendorPostingGroups.id, vendor.postingGroupId));
      if (group?.payablesAccountId == null || group.prepaymentsAccountId == null) throw new FinanceError('POSTING_GROUP', 'The vendor’s posting group needs a payables and a prepayments account.');
      const today = businessDate(now);
      const { registerId } = await this.engine.post(
        {
          companyId: ctx.companyId,
          idempotencyKey: `advance-application:${adv.id}:${inv.p.id}`,
          postingDate: today,
          documentType: 'vendor_advance_application',
          documentNo: inv.p.number,
          description: `${vendor?.legalName ?? ''}: advance set against ${inv.p.vendorInvoiceNo}`,
          currency: inv.p.currency,
          rate: '1',
          rateSource: 'base',
          lines: [
            { accountId: group.payablesAccountId, debit: fromCents(cents), credit: '0', description: `Advance applied to ${inv.p.vendorInvoiceNo}`, sourceLedger: 'vendor', sourceEntryId: inv.p.vendorId },
            { accountId: group.prepaymentsAccountId, debit: '0', credit: fromCents(cents), description: `Advance applied to ${inv.p.vendorInvoiceNo}`, sourceLedger: 'vendor', sourceEntryId: inv.p.vendorId },
          ],
          chainKey: 'general',
          origin: ctx.origin,
          source: { type: 'vendor_advance_application', id: adv.id },
          postedBy: 'engine',
        },
        ENGINE,
        tx,
      );
      await this.ledger.apply(tx, { companyId: ctx.companyId, vendorId: inv.p.vendorId, creditEntryId: advEntry.id, invoiceEntryId: invEntry.id, amountCents: cents, postingDate: today, entryType: 'advance_application', registerId, createdBy: ctx.actor.id });
      if (advOpen - cents === 0) await this.advances.appliedIn(tx, ctx.companyId, adv.id, now);
      await this.event(tx, ctx.actor, voucher.id, 'advance_applied', null, null, { data: { invoice: inv.p.number, amount: fromCents(cents), registerId } });
      return { appliedCents: cents };
    });
  }

  // ── reading ──────────────────────────────────────────────────────────────

  /** A new voucher started from a booked invoice: the vendor and the invoice to pay. */
  async prefill(companyId: string, purchaseInvoiceId: string) {
    const [row] = await this.db
      .select({ vendorId: purchaseInvoices.vendorId, vendorName: vendors.legalName, purchaseInvoiceId: purchaseInvoices.id })
      .from(purchaseInvoices)
      .innerJoin(vendors, eq(vendors.id, purchaseInvoices.vendorId))
      .where(and(eq(purchaseInvoices.companyId, companyId), eq(purchaseInvoices.id, purchaseInvoiceId)));
    return row ?? null;
  }

  private async names(ids: readonly (string | null)[]): Promise<Map<string, string>> {
    const clean = [...new Set(ids.filter((x): x is string => x !== null && /^[0-9a-f-]{36}$/i.test(x)))];
    if (clean.length === 0) return new Map();
    const rows = await this.db.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, clean));
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  async list(companyId: string, filter: { status?: string; vendorId?: string; before?: { stamp: string; id: string } | null }, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const found = await this.db
      .select({ v: vendorPaymentVouchers, vendorName: vendors.legalName, methodName: paymentMethods.name, stamp: sql<string>`${vendorPaymentVouchers.createdAt}::text` })
      .from(vendorPaymentVouchers)
      .innerJoin(vendors, eq(vendors.id, vendorPaymentVouchers.vendorId))
      .innerJoin(paymentMethods, eq(paymentMethods.id, vendorPaymentVouchers.methodId))
      .where(and(
        eq(vendorPaymentVouchers.companyId, companyId),
        has(filter.status) ? eq(vendorPaymentVouchers.status, filter.status as VendorVoucherStatus) : undefined,
        has(filter.vendorId) ? eq(vendorPaymentVouchers.vendorId, filter.vendorId) : undefined,
        filter.before === undefined || filter.before === null ? undefined : sql`(${vendorPaymentVouchers.createdAt}::text, ${vendorPaymentVouchers.id}::text) < (${filter.before.stamp}, ${filter.before.id})`,
      ))
      .orderBy(desc(vendorPaymentVouchers.createdAt), desc(vendorPaymentVouchers.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const last = page.at(-1);
    return {
      rows: page.map((x) => ({ id: x.v.id, number: x.v.number, status: x.v.status, kind: x.v.kind, vendorName: x.vendorName, methodName: x.methodName, amount: x.v.amount, currency: x.v.currency, createdAt: x.v.createdAt.toISOString() })),
      next: found.length > take && last !== undefined ? { stamp: last.stamp, id: last.v.id } : null,
    };
  }

  async get(companyId: string, id: string) {
    const [head] = await this.db
      .select({ v: vendorPaymentVouchers, vendorName: vendors.legalName, methodName: paymentMethods.name, methodKind: paymentMethods.kind })
      .from(vendorPaymentVouchers)
      .innerJoin(vendors, eq(vendors.id, vendorPaymentVouchers.vendorId))
      .innerJoin(paymentMethods, eq(paymentMethods.id, vendorPaymentVouchers.methodId))
      .where(and(eq(vendorPaymentVouchers.companyId, companyId), eq(vendorPaymentVouchers.id, id)));
    if (head === undefined) return null;
    const v = head.v;
    const [lines, events, adv] = await Promise.all([
      this.db.select({ l: vendorPaymentVoucherLines, number: purchaseInvoices.number, vendorInvoiceNo: purchaseInvoices.vendorInvoiceNo, total: purchaseInvoices.total }).from(vendorPaymentVoucherLines).innerJoin(purchaseInvoices, eq(purchaseInvoices.id, vendorPaymentVoucherLines.purchaseInvoiceId)).where(eq(vendorPaymentVoucherLines.voucherId, id)),
      this.db.select().from(vendorPaymentEvents).where(eq(vendorPaymentEvents.voucherId, id)).orderBy(desc(vendorPaymentEvents.id)).limit(100),
      v.advanceId === null ? Promise.resolve(undefined) : this.db.select({ a: vendorAdvancePayments, poNumber: purchaseOrders.number }).from(vendorAdvancePayments).innerJoin(purchaseOrders, eq(purchaseOrders.id, vendorAdvancePayments.poId)).where(eq(vendorAdvancePayments.id, v.advanceId)).then((r) => r[0]),
    ]);
    const names = await this.names([v.createdBy, v.approvedBy, v.paidBy, v.reversedBy, ...events.map((e) => e.actorId)]);
    const who = (x: string | null): string | null => (x === null ? null : (names.get(x) ?? 'Someone'));
    return {
      voucher: { ...v, createdAt: v.createdAt.toISOString(), updatedAt: v.updatedAt.toISOString(), submittedAt: v.submittedAt?.toISOString() ?? null, approvedAt: v.approvedAt?.toISOString() ?? null, paidAt: v.paidAt?.toISOString() ?? null, reversedAt: v.reversedAt?.toISOString() ?? null },
      vendorName: head.vendorName,
      methodName: head.methodName,
      methodKind: head.methodKind,
      createdName: who(v.createdBy),
      approvedName: who(v.approvedBy),
      paidName: who(v.paidBy),
      advance: adv === undefined ? null : { id: adv.a.id, orderNumber: adv.poNumber ?? '', amount: adv.a.amount, reason: adv.a.reason },
      lines: lines.map((x) => ({ purchaseInvoiceId: x.l.purchaseInvoiceId, number: x.number, vendorInvoiceNo: x.vendorInvoiceNo, invoiceTotal: x.total, amount: x.l.amount })),
      events: events.map((e) => ({ id: e.id, event: e.event, reason: e.reasonText, at: e.createdAt.toISOString(), who: who(e.actorId) })),
    };
  }

  // ── the vendor's own view ────────────────────────────────────────────────

  async remittances(vendorId: string, before: { stamp: string; id: string } | null = null, limit = 50) {
    const take = Math.min(Math.max(limit, 1), 100);
    const found = await this.db
      .select({ v: vendorPaymentVouchers, stamp: sql<string>`${vendorPaymentVouchers.paidAt}::text` })
      .from(vendorPaymentVouchers)
      .where(and(eq(vendorPaymentVouchers.vendorId, vendorId), eq(vendorPaymentVouchers.status, 'paid'), before === null ? undefined : sql`(${vendorPaymentVouchers.paidAt}::text, ${vendorPaymentVouchers.id}::text) < (${before.stamp}, ${before.id})`))
      .orderBy(desc(vendorPaymentVouchers.paidAt), desc(vendorPaymentVouchers.id))
      .limit(take + 1);
    const page = found.slice(0, take);
    const ids = page.map((p) => p.v.id);
    const lines = ids.length === 0 ? [] : await this.db.select({ voucherId: vendorPaymentVoucherLines.voucherId, vendorInvoiceNo: purchaseInvoices.vendorInvoiceNo, amount: vendorPaymentVoucherLines.amount }).from(vendorPaymentVoucherLines).innerJoin(purchaseInvoices, eq(purchaseInvoices.id, vendorPaymentVoucherLines.purchaseInvoiceId)).where(inArray(vendorPaymentVoucherLines.voucherId, ids));
    const last = page.at(-1);
    return {
      rows: page.map((p) => ({ id: p.v.id, number: p.v.number ?? '', kind: p.v.kind, paidOn: p.v.paidOn ?? '', reference: p.v.paymentReference ?? '', amount: p.v.amount, currency: p.v.currency, destination: p.v.destination, invoices: lines.filter((l) => l.voucherId === p.v.id).map((l) => ({ vendorInvoiceNo: l.vendorInvoiceNo, amount: l.amount })) })),
      next: found.length > take && last !== undefined ? { stamp: last.stamp, id: last.v.id } : null,
    };
  }
}
