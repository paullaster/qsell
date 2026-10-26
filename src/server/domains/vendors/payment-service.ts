import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  bankStatementLines,
  providerOperations,
  bankLedgerEntries,
  financeSettings,
  paymentMethods,
  purchaseInvoices,
  purchaseOrders,
  supplierInvoices,
  users,
  vendorAdvancePayments,
  vendorBankAccounts,
  vendorCreditMemoEvents,
  vendorLedgerEntries,
  vendorPaymentEvents,
  vendorPaymentVoucherLines,
  vendorPaymentVouchers,
  vendorPostingGroups,
  vendorSettings,
  vendors,
  withholdingCertificates,
  withholdingCodes,
  type VendorBankAccountRow,
  type VendorPaymentVoucherRow,
  type VendorVoucherStatus,
} from '@/server/db/drizzle/schema';
import { has, trimToNull } from '@/lib/values';
import { daysBetween, paymentFlags } from '@/lib/vendor-insights';
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
import { SettlementError, settle, type Settlement } from '@/lib/vendor-settlement';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { PostingEngine } from '@/server/domains/finance/engine';
import type { VendorLedgerService } from '@/server/domains/finance/payables/vendor-ledger-service';
import { FinanceError, type FinanceContext } from '@/server/domains/finance/errors';
import type { AdvancePaymentService } from './advance-service';
import type { FxService } from '@/server/domains/finance/fx-service';
import { settlementGain } from '@/lib/vendor-fx';
import { describeDestination } from '@/lib/vendor-profile';
import { payoutPlan, wholeShillings } from '@/lib/vendor-payout';
import type { VendorNotifier } from './notifier';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
interface Actor {
  type: 'user' | 'system' | 'job' | 'integration';
  id: string | null;
}
const ENGINE = { canPostSoftClosed: false, canPostControlAccounts: true };
export interface PaidResult {
  vendorId: string;
  number: string;
  registerId: string;
  amount: string;
  currency: string;
  reference: string;
  invoiceNos: string[];
}

const describePayment = (kind: string, vendorName: string, invoiceNos: string[]): string => {
  if (kind === 'advance') return `${vendorName}: advance payment`;
  if (kind === 'on_account') return `${vendorName}: payment on account`;
  return `${vendorName}: payment of ${invoiceNos.join(', ')}`;
};

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
    private readonly fx: FxService,
    private readonly notify?: VendorNotifier,
  ) {}

  /** Closes a bank statement line against the bank entry of a payment made from it. Set by the container so this service does not depend on the bank module. */
  private statementMatcher: ((tx: Tx, ctx: FinanceContext, lineId: number, bankEntryId: number) => Promise<void>) | null = null;

  useStatementMatcher(matcher: (tx: Tx, ctx: FinanceContext, lineId: number, bankEntryId: number) => Promise<void>): void {
    this.statementMatcher = matcher;
  }

  private async event(tx: Tx | DrizzleDb, actor: Actor, voucherId: string, event: string, from: string | null, to: string | null, extra: { reason?: string | null; data?: Record<string, unknown> } = {}): Promise<void> {
    await tx.insert(vendorPaymentEvents).values({ voucherId, event, fromStatus: from, toStatus: to, reasonText: extra.reason ?? null, data: extra.data ?? {}, actorType: actor.type, actorId: actor.id });
  }

  /** Runs in the caller's transaction when it gave one (a payment run does many things as one), otherwise in its own. */
  private async inTx<T>(tx: Tx | undefined, fn: (tx: Tx) => Promise<T>): Promise<T> {
    return tx === undefined ? await this.db.transaction(fn) : await fn(tx);
  }

  private async lock(tx: Tx, companyId: string, id: string): Promise<VendorPaymentVoucherRow> {
    const [v] = await tx.select().from(vendorPaymentVouchers).where(and(eq(vendorPaymentVouchers.companyId, companyId), eq(vendorPaymentVouchers.id, id))).for('update');
    if (v === undefined) throw new FinanceError('NOT_FOUND', 'That payment voucher does not exist.');
    return v;
  }

  /** Why this payment deserves a second look (a large payment to a new vendor, a bank account shared with another vendor), and whether the company holds such payments. */
  private async flagsFor(tx: Tx, companyId: string, vendorId: string, accountId: string | null, amountCents: number, now: Date): Promise<{ reasons: string[]; hold: boolean }> {
    const [s] = await tx.select().from(vendorSettings).where(eq(vendorSettings.companyId, companyId));
    const [vendor] = await tx.select({ createdAt: vendors.createdAt }).from(vendors).where(eq(vendors.id, vendorId));
    let shares = false;
    if (accountId !== null) {
      const [own] = await tx.select({ hash: vendorBankAccounts.accountHash }).from(vendorBankAccounts).where(eq(vendorBankAccounts.id, accountId));
      if (own !== undefined) {
        const [other] = await tx.select({ id: vendorBankAccounts.id }).from(vendorBankAccounts).innerJoin(vendors, eq(vendors.id, vendorBankAccounts.vendorId)).where(and(eq(vendors.companyId, companyId), eq(vendorBankAccounts.accountHash, own.hash), ne(vendorBankAccounts.vendorId, vendorId), inArray(vendorBankAccounts.status, ['active', 'pending_change']))).limit(1);
        shares = other !== undefined;
      }
    }
    const age = vendor === undefined ? 0 : daysBetween(vendor.createdAt.toISOString().slice(0, 10), now.toISOString().slice(0, 10));
    const reasons = paymentFlags({ amountCents, vendorAgeDays: age, sharesBankAccount: shares }, { newVendorDays: s?.watchNewVendorDays ?? 30, newVendorAmountCents: toCents(s?.watchNewVendorAmount ?? '100000') });
    return { reasons, hold: reasons.length > 0 && (s?.holdFlaggedPayments ?? true) };
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
    return { method: m, base: fs.base, currency: bank.currency };
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

  /**
   * Every booked invoice with something to pay that falls due on or before a date, for all vendors or one, net of what live vouchers
   * hold: the raw material of a payment proposal. Read in two queries however many vendors there are.
   */
  async dueItems(companyId: string, f: { dueOn: string; vendorId?: string }, limit = 2000) {
    const rows = await this.db
      .select({ p: purchaseInvoices, remaining: vendorLedgerEntries.remainingAmount, vendorName: vendors.legalName, block: vendors.block, vendorStatus: vendors.status })
      .from(purchaseInvoices)
      .innerJoin(vendorLedgerEntries, eq(vendorLedgerEntries.id, purchaseInvoices.ledgerEntryId))
      .innerJoin(vendors, eq(vendors.id, purchaseInvoices.vendorId))
      .where(and(eq(purchaseInvoices.companyId, companyId), sql`${vendorLedgerEntries.remainingAmount} > 0`, sql`COALESCE(${purchaseInvoices.dueDate}, ${purchaseInvoices.invoiceDate}) <= ${f.dueOn}::date`, has(f.vendorId) ? eq(purchaseInvoices.vendorId, f.vendorId) : undefined))
      .orderBy(asc(vendors.legalName), asc(purchaseInvoices.dueDate), asc(purchaseInvoices.postedAt))
      .limit(limit);
    const held = rows.length === 0 ? [] : await this.db
      .select({ invoiceId: vendorPaymentVoucherLines.purchaseInvoiceId, total: sql<string>`COALESCE(SUM(${vendorPaymentVoucherLines.amount}), 0)::text` })
      .from(vendorPaymentVoucherLines)
      .innerJoin(vendorPaymentVouchers, eq(vendorPaymentVouchers.id, vendorPaymentVoucherLines.voucherId))
      .where(and(inArray(vendorPaymentVoucherLines.purchaseInvoiceId, rows.map((r) => r.p.id)), inArray(vendorPaymentVouchers.status, [...LIVE_VOUCHER])))
      .groupBy(vendorPaymentVoucherLines.purchaseInvoiceId);
    const heldBy = new Map(held.map((h) => [h.invoiceId, toCents(h.total)]));
    return rows
      .map((r) => ({ purchaseInvoiceId: r.p.id, vendorId: r.p.vendorId, vendorName: r.vendorName, block: r.block, number: r.p.number, vendorInvoiceNo: r.p.vendorInvoiceNo, invoiceDate: r.p.invoiceDate, dueDate: r.p.dueDate, availableCents: Math.max(0, toCents(r.remaining) - (heldBy.get(r.p.id) ?? 0)) }))
      .filter((r) => r.availableCents > 0);
  }

  /** A way of paying as the run needs it: its kind, its bank account and the account number the bank file is paid from. */
  async methodForRun(companyId: string, methodId: string) {
    const { method, currency } = await this.method(this.db, companyId, methodId);
    const [bank] = await this.db.select().from(bankAccounts).where(eq(bankAccounts.id, method.balancingBankAccountId));
    return { id: method.id, name: method.name, kind: method.kind, currency, bankCode: bank?.code ?? '', debtorAccount: (bank?.details.accountNumber ?? '').trim(), needsAccount: NEEDS_ACCOUNT.includes(method.kind) };
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

  /**
   * Works out what paying these invoices does (design doc §12.5): the discount the vendor allows if paid in time, tax withheld by the
   * vendor's code, a small leftover closed as tolerance. The terms are judged on `asOf`; the open balances are read as they are now.
   */
  async planFor(db: Tx | DrizzleDb, companyId: string, vendorId: string, allocations: readonly AllocationForm[], asOf: string): Promise<Settlement> {
    const [vendor] = await db.select().from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.id, vendorId)));
    if (vendor === undefined) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    const [code] = vendor.withholdingCodeId === null ? [] : await db.select().from(withholdingCodes).where(and(eq(withholdingCodes.id, vendor.withholdingCodeId), eq(withholdingCodes.active, true)));
    const [settings] = await db.select({ t: vendorSettings.paymentToleranceAmount }).from(vendorSettings).where(eq(vendorSettings.companyId, companyId));
    const ids = allocations.map((a) => a.purchaseInvoiceId);
    const rows = ids.length === 0 ? [] : await db
      .select({ p: purchaseInvoices, remaining: vendorLedgerEntries.remainingAmount })
      .from(purchaseInvoices)
      .innerJoin(vendorLedgerEntries, eq(vendorLedgerEntries.id, purchaseInvoices.ledgerEntryId))
      .where(and(eq(purchaseInvoices.companyId, companyId), eq(purchaseInvoices.vendorId, vendorId), inArray(purchaseInvoices.id, ids)));
    const byId = new Map(rows.map((r) => [r.p.id, r]));
    try {
      return settle(
        allocations.map((a) => {
          const r = byId.get(a.purchaseInvoiceId);
          if (r === undefined) throw new FinanceError('NOT_FOUND', 'One of those invoices is not this vendor’s.');
          return { purchaseInvoiceId: a.purchaseInvoiceId, grossCents: toCents(a.amount), invoiceDate: r.p.invoiceDate, invoiceTotalCents: toCents(r.p.total), invoiceSubtotalCents: toCents(r.p.subtotal), openCents: toCents(r.remaining), closeRemainder: a.closeRemainder === true };
        }),
        {
          discountPercent: Number(vendor.earlyDiscountPercent),
          discountDays: vendor.earlyDiscountDays,
          withholding: code === undefined ? null : { ratePercent: Number(code.ratePercent), base: code.base },
          toleranceCents: toCents(settings?.t ?? '0'),
          asOf,
        },
      );
    } catch (error) {
      if (error instanceof SettlementError) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }

  async saveDraft(ctx: FinanceContext, id: string | null, header: VoucherHeaderForm, allocations: AllocationForm[], opts: { tx?: Tx; batchId?: string } = {}): Promise<{ id: string; amount: string; cash: string }> {
    const first = Object.values(checkVoucherHeader(header))[0];
    if (has(first)) throw new FinanceError('INVALID', first);
    return await this.inTx(opts.tx, async (tx) => {
      await this.vendorMayBePaid(tx, ctx.companyId, header.vendorId);
      const { method, base, currency } = await this.method(tx, ctx.companyId, header.methodId);
      if (currency !== base && header.kind !== 'invoices') throw new FinanceError('FOREIGN_CURRENCY', `That way of paying is in ${currency}. In another currency only vendor invoices can be paid for now: not a payment on account or an advance.`);
      let amountCents: number;
      let plan: Settlement | null = null;
      let lines: { purchaseInvoiceId: string; amount: string; closeRemainder: boolean; discount: string; tolerance: string; withholdingBase: string; withholding: string }[] = [];
      if (header.kind === 'invoices') {
        const items = await this.openItems(ctx.companyId, header.vendorId, id);
        const checked = checkAllocations(items, allocations);
        const problem = Object.values(checked.problems)[0];
        if (has(problem)) throw new FinanceError('INVALID', problem);
        const chosen = allocations.length === 0 ? [] : await tx.select({ number: purchaseInvoices.number, currency: purchaseInvoices.currency }).from(purchaseInvoices).where(inArray(purchaseInvoices.id, allocations.map((a) => a.purchaseInvoiceId)));
        const wrong = chosen.find((i) => i.currency !== currency);
        if (wrong !== undefined) throw new FinanceError('CURRENCY_MISMATCH', `Invoice ${wrong.number} is in ${wrong.currency}, and this way of paying is in ${currency}. Pay it with a way of paying in ${wrong.currency}.`);
        amountCents = checked.totalCents;
        plan = await this.planFor(tx, ctx.companyId, header.vendorId, allocations, businessDate());
        const settled = plan.lines;
        lines = allocations.map((a, i) => ({ purchaseInvoiceId: a.purchaseInvoiceId, amount: fromCents(toCents(a.amount)), closeRemainder: a.closeRemainder === true, discount: fromCents(settled[i]?.discountCents ?? 0), tolerance: fromCents(settled[i]?.toleranceCents ?? 0), withholdingBase: fromCents(settled[i]?.withholdingBaseCents ?? 0), withholding: fromCents(settled[i]?.withholdingCents ?? 0) }));
      } else if (header.kind === 'on_account') {
        amountCents = toCents(header.amount ?? '0');
      } else {
        const [adv] = await tx.select().from(vendorAdvancePayments).where(and(eq(vendorAdvancePayments.companyId, ctx.companyId), eq(vendorAdvancePayments.id, header.advanceId), eq(vendorAdvancePayments.vendorId, header.vendorId)));
        if (adv === undefined) throw new FinanceError('NOT_FOUND', 'That advance payment does not exist for this vendor.');
        if (adv.status !== 'approved') throw new FinanceError('NOT_APPROVED', 'Only an approved advance payment can be paid.');
        if (adv.currency !== base) throw new FinanceError('FOREIGN_CURRENCY', `That advance is in ${adv.currency}. Paying in another currency needs an exchange rate, which is not built yet.`);
        amountCents = toCents(adv.amount);
      }
      if (amountCents <= 0) throw new FinanceError('INVALID', 'The payment must be for more than zero.');
      const values = { ...(opts.batchId === undefined ? {} : { batchId: opts.batchId }), vendorId: header.vendorId, kind: header.kind, currency, amount: fromCents(amountCents), withholdingAmount: fromCents(plan?.withholdingCents ?? 0), discountAmount: fromCents(plan?.discountCents ?? 0), toleranceAmount: fromCents(plan?.toleranceCents ?? 0), cashAmount: fromCents(plan?.cashCents ?? amountCents), methodId: method.id, advanceId: header.kind === 'advance' ? header.advanceId : null, narration: trimToNull(header.narration), updatedAt: new Date() };
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
      return { id: voucherId, amount: fromCents(amountCents), cash: fromCents(plan?.cashCents ?? amountCents) };
    });
  }

  /**
   * A payment that already left the bank, seen on the statement. It becomes a voucher for the vendor's oldest open invoices (or a
   * payment on account), sent for approval like any other; when it is recorded as paid on the day of the line, the line is
   * matched to its bank entry in the same step. Only an exact match is made, so the cash must equal the line.
   */
  async createFromStatementLine(ctx: FinanceContext, lineId: number, input: { vendorId: string; methodId: string; mode: 'oldest_first' | 'on_account' }, now: Date = new Date()): Promise<{ id: string; amount: string }> {
    return await this.db.transaction(async (tx) => {
      const [line] = await tx.select().from(bankStatementLines).where(and(eq(bankStatementLines.companyId, ctx.companyId), eq(bankStatementLines.id, lineId))).for('update');
      if (line === undefined) throw new FinanceError('LINE_NOT_FOUND', 'That statement line does not exist.');
      if (line.reconciliationId !== null) throw new FinanceError('LINE_RECONCILED', 'This line is part of a posted reconciliation.');
      if (line.status === 'matched' || line.status === 'ignored') throw new FinanceError('LINE_CLOSED', `This line is already ${line.status}.`);
      const cents = -toCents(Number(line.amount).toFixed(2));
      if (cents <= 0) throw new FinanceError('NOT_A_PAYMENT', 'Only money paid out can become a payment to a vendor.');
      const [taken] = await tx.select({ id: vendorPaymentVouchers.id }).from(vendorPaymentVouchers).where(and(eq(vendorPaymentVouchers.statementLineId, lineId), ne(vendorPaymentVouchers.status, 'cancelled')));
      if (taken !== undefined) throw new FinanceError('ALREADY_STARTED', 'A payment has already been made from this line.');
      const { method } = await this.method(tx, ctx.companyId, input.methodId);
      if (method.balancingBankAccountId !== line.bankAccountId) throw new FinanceError('METHOD_ACCOUNT', 'That way of paying does not pay out of this bank account.');
      await this.vendorMayBePaid(tx, ctx.companyId, input.vendorId);
      let allocations: AllocationForm[] = [];
      let header: VoucherHeaderForm;
      if (input.mode === 'oldest_first') {
        const items = await this.openItems(ctx.companyId, input.vendorId, null);
        let left = cents;
        allocations = [];
        for (const item of [...items].sort((a, b) => (a.dueDate ?? a.invoiceDate).localeCompare(b.dueDate ?? b.invoiceDate))) {
          if (left <= 0) break;
          const take = Math.min(left, item.availableCents);
          if (take > 0) {
            allocations.push({ purchaseInvoiceId: item.purchaseInvoiceId, amount: fromCents(take) });
            left -= take;
          }
        }
        if (left > 0) throw new FinanceError('NOT_ENOUGH_OPEN', `The vendor’s open invoices come to ${fromCents(cents - left)}, less than the ${fromCents(cents)} the bank paid. Record the rest as a payment on account instead.`);
        header = { kind: 'invoices', vendorId: input.vendorId, methodId: input.methodId, narration: `Paid on ${line.lineDate}: ${line.description}`.slice(0, 300), advanceId: '' };
      } else {
        header = { kind: 'on_account', vendorId: input.vendorId, methodId: input.methodId, narration: `Paid on ${line.lineDate}: ${line.description}`.slice(0, 300), advanceId: '', amount: fromCents(cents) };
      }
      const made = await this.saveDraft(ctx, null, header, allocations, { tx });
      if (toCents(made.cash) !== cents) throw new FinanceError('CASH_DIFFERS', `After tax withheld or a discount, this payment would send ${made.cash}, not the ${fromCents(cents)} the bank paid. Make the payment from Payments instead and match the line to it.`);
      await tx.update(vendorPaymentVouchers).set({ statementLineId: lineId }).where(eq(vendorPaymentVouchers.id, made.id));
      await this.event(tx, ctx.actor, made.id, 'from_statement_line', 'draft', 'draft', { data: { lineId, lineDate: line.lineDate, reference: line.reference } });
      await this.submit(ctx, made.id, now, tx);
      return { id: made.id, amount: made.amount };
    });
  }

  async submit(ctx: FinanceContext, id: string, now: Date = new Date(), outer?: Tx): Promise<void> {
    await this.inTx(outer, async (tx) => {
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

  async approve(ctx: FinanceContext, id: string, now: Date = new Date(), outer?: Tx): Promise<{ number: string }> {
    return await this.inTx(outer, async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (v.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This payment voucher is not waiting for approval.');
      const refusal = approvalRefusal(ctx.actor.id ?? '', v.createdBy);
      if (refusal !== null) throw new FinanceError('FOUR_EYES', refusal);
      await this.vendorMayBePaid(tx, ctx.companyId, v.vendorId);
      if (v.kind === 'invoices') await this.recheckLines(tx, ctx.companyId, v);
      const { method } = await this.method(tx, ctx.companyId, v.methodId);
      // What the payment settles is fixed now, on the day it is approved: the discount in time, the tax withheld, the cash.
      let plan: Settlement | null = null;
      if (v.kind === 'invoices') {
        const rows = await tx.select().from(vendorPaymentVoucherLines).where(eq(vendorPaymentVoucherLines.voucherId, id));
        plan = await this.planFor(tx, ctx.companyId, v.vendorId, rows.map((l) => ({ purchaseInvoiceId: l.purchaseInvoiceId, amount: l.amount, closeRemainder: l.closeRemainder })), businessDate(now));
        for (const l of plan.lines) {
          await tx.update(vendorPaymentVoucherLines).set({ discount: fromCents(l.discountCents), tolerance: fromCents(l.toleranceCents), withholdingBase: fromCents(l.withholdingBaseCents), withholding: fromCents(l.withholdingCents) }).where(and(eq(vendorPaymentVoucherLines.voucherId, id), eq(vendorPaymentVoucherLines.purchaseInvoiceId, l.purchaseInvoiceId)));
        }
      }
      let accountId: string | null = null;
      let destination: string | null = null;
      if (NEEDS_ACCOUNT.includes(method.kind)) {
        // A way of paying through M-Pesa pays an M-Pesa destination of the vendor; every other way pays a bank account.
        const mobile = method.kind === 'mobile_money';
        const active = await tx.select().from(vendorBankAccounts).where(and(eq(vendorBankAccounts.vendorId, v.vendorId), eq(vendorBankAccounts.status, 'active'), mobile ? inArray(vendorBankAccounts.kind, ['mpesa_phone', 'mpesa_paybill', 'mpesa_till']) : eq(vendorBankAccounts.kind, 'bank'))).orderBy(desc(vendorBankAccounts.createdAt));
        const account = active[0];
        if (account === undefined) throw new FinanceError('NO_BANK_ACCOUNT', mobile ? 'The vendor has no M-Pesa number, paybill or till that can receive money. A new or changed destination is usable only after it is approved and its waiting period has passed.' : 'The vendor has no bank account that can receive money. A new or changed account is usable only after it is approved and its waiting period has passed.');
        accountId = account.id;
        destination = describeDestination(account.kind, account.bankName, account.branch, account.accountLast4);
      }
      const threshold = await this.thresholdCents(tx, ctx.companyId);
      const flags = await this.flagsFor(tx, ctx.companyId, v.vendorId, accountId, toCents(v.amount), now);
      const three = needsThreePeople(toCents(v.amount), threshold) || flags.hold;
      const number = v.number ?? (await this.numbering.assign('vendor_payment', { companyId: ctx.companyId, branchId: null, date: businessDate(now), document: { kind: 'vendor_payment', id } }, tx)).number;
      await tx.update(vendorPaymentVouchers).set({ status: 'approved', number, approvedBy: ctx.actor.id, approvedAt: now, needsThree: three, vendorBankAccountId: accountId, destination, ...(plan === null ? {} : { withholdingAmount: fromCents(plan.withholdingCents), discountAmount: fromCents(plan.discountCents), toleranceAmount: fromCents(plan.toleranceCents), cashAmount: fromCents(plan.cashCents) }), updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
      await this.event(tx, ctx.actor, id, 'approved', 'pending_approval', 'approved', { data: { number, needsThree: three, flagged: flags.reasons, destination, cash: fromCents(plan?.cashCents ?? toCents(v.amount)), withholding: fromCents(plan?.withholdingCents ?? 0), discount: fromCents(plan?.discountCents ?? 0) } });
      return { number };
    });
  }

  async sendBack(ctx: FinanceContext, id: string, reason: string, now: Date = new Date(), outer?: Tx): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the payment is sent back.');
    await this.inTx(outer, async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (v.status !== 'pending_approval') throw new FinanceError('WRONG_STATE', 'This payment voucher is not waiting for approval.');
      await tx.update(vendorPaymentVouchers).set({ status: 'draft', sendBackReason: text.slice(0, 500), updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
      await this.event(tx, ctx.actor, id, 'sent_back', 'pending_approval', 'draft', { reason: text.slice(0, 500) });
    });
  }

  async cancel(ctx: FinanceContext, id: string, reason: string, now: Date = new Date(), outer?: Tx): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the payment is cancelled.');
    await this.inTx(outer, async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (!(LIVE_VOUCHER as readonly string[]).includes(v.status)) throw new FinanceError('WRONG_STATE', v.status === 'paid' ? 'A paid voucher cannot be cancelled. Reverse it.' : 'This payment voucher is finished.');
      await tx.update(vendorPaymentVouchers).set({ status: 'cancelled', cancelReason: text.slice(0, 500), updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
      await this.event(tx, ctx.actor, id, 'cancelled', v.status, 'cancelled', { reason: text.slice(0, 500) });
    });
  }

  /** The money leaves. Everything happens in one transaction or none of it does. */
  async pay(ctx: FinanceContext, id: string, input: { reference: string; paidOn: string }, now: Date = new Date()): Promise<{ number: string; registerId: string }> {
    const done = await this.db.transaction(async (tx) => await this.payIn(tx, ctx, id, input, now));
    await this.tellPaid(done);
    return { number: done.number, registerId: done.registerId };
  }

  /** Tells the vendor, after the transaction that paid has committed. A mail that cannot be sent never undoes a payment. */
  async tellPaid(done: PaidResult): Promise<void> {
    await this.notify?.paymentMade(done.vendorId, done.number, done.amount, done.currency, done.reference, done.invoiceNos);
  }

  /** The payment inside the caller's transaction, so many vouchers can be paid together or not at all. */
  async payIn(tx: Tx, ctx: FinanceContext, id: string, input: { reference: string; paidOn: string }, now: Date = new Date()): Promise<PaidResult> {
    const reference = trimToNull(input.reference);
    const today = businessDate(now);
    if (!has(reference)) throw new FinanceError('REFERENCE_REQUIRED', 'Enter the reference of the payment: the transfer, cheque or receipt number.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.paidOn) || input.paidOn > today) throw new FinanceError('INVALID', 'Enter the date the money was paid, not in the future.');
    const v = await this.lock(tx, ctx.companyId, id);
    if (v.status !== 'approved') throw new FinanceError('WRONG_STATE', v.status === 'paid' ? 'This voucher has already been paid.' : 'Only an approved voucher can be paid.');
    const refusal = releaseRefusal(ctx.actor.id ?? '', v.createdBy, v.approvedBy, v.needsThree);
    if (refusal !== null) throw new FinanceError('THREE_PEOPLE', refusal);
    const vendor = await this.vendorMayBePaid(tx, ctx.companyId, v.vendorId);
    const { method, base } = await this.method(tx, ctx.companyId, v.methodId);
    // Money in another currency is valued at the rate of the day it was paid.
    const foreign = v.currency !== base;
    const rate = foreign ? await this.fx.requireRate(tx, ctx.companyId, v.currency, input.paidOn) : '1';
    // A payment made from a bank statement line is recorded on the day the bank shows it.
    const [fromLine] = v.statementLineId === null ? [] : await tx.select().from(bankStatementLines).where(eq(bankStatementLines.id, v.statementLineId));
    if (fromLine !== undefined && input.paidOn !== fromLine.lineDate) throw new FinanceError('INVALID', `This payment was made from a bank statement line dated ${fromLine.lineDate}. Record it as paid on that date.`);
    if (v.vendorBankAccountId !== null) {
      const [account] = await tx.select({ status: vendorBankAccounts.status }).from(vendorBankAccounts).where(eq(vendorBankAccounts.id, v.vendorBankAccountId));
      if (account?.status !== 'active') throw new FinanceError('DESTINATION_CHANGED', 'The vendor’s bank account this voucher was approved for is no longer in use. Cancel it and make a new voucher.');
    }
    if (vendor.postingGroupId === null) throw new FinanceError('POSTING_GROUP', `${vendor.legalName} has no posting group. Choose one on the vendor’s financial settings first.`);
    const [group] = await tx.select().from(vendorPostingGroups).where(eq(vendorPostingGroups.id, vendor.postingGroupId));
    const debitAccount = v.kind === 'advance' ? group?.prepaymentsAccountId : group?.payablesAccountId;
    if (debitAccount === null || debitAccount === undefined) throw new FinanceError('POSTING_GROUP', v.kind === 'advance' ? 'The vendor’s posting group has no prepayments account for advances.' : 'The vendor’s posting group has no payables account.');
    const lines = await tx.select().from(vendorPaymentVoucherLines).where(eq(vendorPaymentVoucherLines.voucherId, id));
    const invoices = lines.length === 0 ? [] : await tx.select().from(purchaseInvoices).where(inArray(purchaseInvoices.id, lines.map((l) => l.purchaseInvoiceId)));
    const cents = toCents(v.amount);
    const description = describePayment(v.kind, vendor.legalName, invoices.map((i) => i.vendorInvoiceNo));
    // What the payment settles was fixed when it was approved: cash out, tax withheld, discount taken, leftover closed.
    const discountCents = toCents(v.discountAmount);
    const withholdingCents = toCents(v.withholdingAmount);
    const toleranceCents = toCents(v.toleranceAmount);
    const cashCents = toCents(v.cashAmount);
    const journal: { accountId: string; debit: string; credit: string; description: string; sourceLedger?: string; sourceEntryId?: string }[] = [
      { accountId: debitAccount, debit: fromCents(cents + toleranceCents), credit: '0', description, sourceLedger: 'vendor', sourceEntryId: v.vendorId },
    ];
    if (cashCents > 0) journal.push({ accountId: method.glAccountId, debit: '0', credit: fromCents(cashCents), description: `${method.name} ${reference}`, sourceLedger: 'bank', sourceEntryId: method.balancingBankAccountId });
    const needAccount = (id: string | null | undefined, what: string): string => {
      if (id === null || id === undefined) throw new FinanceError('POSTING_GROUP', `The vendor’s posting group has no ${what} account. Choose one in the ordering rules.`);
      return id;
    };
    if (withholdingCents > 0) journal.push({ accountId: needAccount(group?.withholdingPayableAccountId, 'withholding tax payable'), debit: '0', credit: fromCents(withholdingCents), description: `Tax withheld: ${description}` });
    if (discountCents > 0) journal.push({ accountId: needAccount(group?.paymentDiscountAccountId, 'payment discount received'), debit: '0', credit: fromCents(discountCents), description: `Early-payment discount: ${description}` });
    if (toleranceCents > 0) journal.push({ accountId: needAccount(group?.paymentToleranceAccountId, 'payment tolerance'), debit: '0', credit: fromCents(toleranceCents), description: `Leftover closed: ${description}` });
    const { registerId } = await this.engine.post(
      {
        companyId: ctx.companyId,
        idempotencyKey: `vendor-payment:${id}`,
        postingDate: input.paidOn,
        documentType: 'vendor_payment',
        documentNo: v.number ?? '',
        description,
        currency: v.currency,
        rate,
        rateSource: foreign ? 'rate_table' : 'base',
        lines: journal,
        chainKey: 'general',
        origin: ctx.origin,
        source: { type: 'vendor_payment', id },
        postedBy: 'engine',
      },
      ENGINE,
      tx,
    );
    const entryId = randomUUID();
    // The payment entry is what the vendor is paid and credited with: the cash and the tax withheld on its behalf.
    await this.ledger.addEntry(tx, { id: entryId, companyId: ctx.companyId, vendorId: v.vendorId, documentType: v.kind === 'advance' ? 'advance' : 'payment', documentNo: v.number ?? '', documentId: id, description, amountCents: -(cents - discountCents), currency: v.currency, rate, postingDate: input.paidOn, registerId, idempotencyKey: `vendor-payment:${id}`, createdBy: ctx.actor.id });
    // The money leaves the bank account: the bank's own sub-ledger shows it, so the statement can be matched to it.
    if (cashCents > 0) {
      const [bankEntry] = await tx.insert(bankLedgerEntries).values({ companyId: ctx.companyId, bankAccountId: method.balancingBankAccountId, glAccountId: method.glAccountId, postingDate: input.paidOn, documentType: 'vendor_payment', documentNo: v.number ?? '', documentId: id, description: `${vendor.legalName}: ${reference}`.slice(0, 200), amount: fromCents(-cashCents), currency: v.currency, registerId, createdBy: ctx.actor.id }).returning({ id: bankLedgerEntries.id });
      if (fromLine !== undefined && bankEntry !== undefined) {
        if (this.statementMatcher === null) throw new FinanceError('NOT_AVAILABLE', 'Matching bank statement lines is not set up.');
        await this.statementMatcher(tx, ctx, fromLine.id, bankEntry.id);
      }
    }
    const invoiceRates = new Map<string, string>();
    if (foreign && invoices.length > 0) {
      const rows = await tx.select({ id: vendorLedgerEntries.id, rate: vendorLedgerEntries.rate }).from(vendorLedgerEntries).where(inArray(vendorLedgerEntries.id, invoices.map((i) => i.ledgerEntryId)));
      for (const r of rows) invoiceRates.set(r.id, r.rate);
    }
    let gainCents = 0;
    for (const l of lines) {
      const inv = invoices.find((i) => i.id === l.purchaseInvoiceId);
      if (inv === undefined) continue;
      const lineDiscount = toCents(l.discount);
      const lineTolerance = toCents(l.tolerance);
      // What the invoice was booked at against what it cost to settle: the liability cleared is the amount paid plus what was closed.
      if (foreign) gainCents += settlementGain(toCents(l.amount) + lineTolerance, invoiceRates.get(inv.ledgerEntryId) ?? '1', rate);
      if (toCents(l.amount) - lineDiscount > 0) await this.ledger.apply(tx, { companyId: ctx.companyId, vendorId: v.vendorId, creditEntryId: entryId, invoiceEntryId: inv.ledgerEntryId, amountCents: toCents(l.amount) - lineDiscount, postingDate: input.paidOn, registerId, createdBy: ctx.actor.id });
      if (lineDiscount > 0) await this.ledger.writeOff(tx, { companyId: ctx.companyId, entryId: inv.ledgerEntryId, entryType: 'payment_discount', amountCents: lineDiscount, postingDate: input.paidOn, registerId, createdBy: ctx.actor.id });
      if (lineTolerance > 0) await this.ledger.writeOff(tx, { companyId: ctx.companyId, entryId: inv.ledgerEntryId, entryType: 'payment_tolerance', amountCents: lineTolerance, postingDate: input.paidOn, registerId, createdBy: ctx.actor.id });
    }
    let fxRegisterId: string | null = null;
    if (gainCents !== 0) {
      const gain = gainCents > 0;
      const account = gain ? group?.fxGainAccountId : group?.fxLossAccountId;
      if (account === null || account === undefined) throw new FinanceError('POSTING_GROUP', `The vendor’s posting group has no exchange ${gain ? 'gain' : 'loss'} account. Choose one in the ordering rules.`);
      const amount = fromCents(Math.abs(gainCents));
      // The payables account was cleared at the invoices' rates in the ledger but at today's rate in the books: this journal, in the books' currency, closes the difference.
      fxRegisterId = (
        await this.engine.post(
          {
            companyId: ctx.companyId,
            idempotencyKey: `vendor-payment-fx:${id}`,
            postingDate: input.paidOn,
            documentType: 'vendor_payment_fx',
            documentNo: v.number ?? '',
            description: `Exchange ${gain ? 'gain' : 'loss'} on ${description}`.slice(0, 200),
            currency: base,
            rate: '1',
            rateSource: 'base',
            lines: [
              { accountId: gain ? debitAccount : account, debit: amount, credit: '0', description: gain ? 'Liability booked at a higher rate than it cost to pay' : 'Exchange loss on paying a vendor', ...(gain ? { sourceLedger: 'vendor', sourceEntryId: v.vendorId } : {}) },
              { accountId: gain ? account : debitAccount, debit: '0', credit: amount, description: gain ? 'Exchange gain on paying a vendor' : 'Liability booked at a lower rate than it cost to pay', ...(gain ? {} : { sourceLedger: 'vendor', sourceEntryId: v.vendorId }) },
            ],
            chainKey: 'general',
            origin: ctx.origin,
            source: { type: 'vendor_payment', id },
            postedBy: 'engine',
          },
          ENGINE,
          tx,
        )
      ).registerId;
    }
    if (withholdingCents > 0) {
      const [code] = await tx.select({ name: withholdingCodes.name, rate: withholdingCodes.ratePercent }).from(withholdingCodes).innerJoin(vendors, eq(vendors.withholdingCodeId, withholdingCodes.id)).where(eq(vendors.id, v.vendorId));
      const certId = randomUUID();
      const { number: certNo } = await this.numbering.assign('withholding_certificate', { companyId: ctx.companyId, branchId: null, date: input.paidOn, document: { kind: 'withholding_certificate', id: certId } }, tx);
      await tx.insert(withholdingCertificates).values({ id: certId, companyId: ctx.companyId, number: certNo, vendorId: v.vendorId, voucherId: id, paidOn: input.paidOn, period: input.paidOn.slice(0, 7), codeName: code?.name ?? 'Withholding tax', ratePercent: code?.rate ?? '0.01', baseAmount: fromCents(lines.reduce((n, l) => n + toCents(l.withholdingBase), 0)), amount: fromCents(withholdingCents), currency: v.currency, createdBy: ctx.actor.id });
    }
    if (v.kind === 'advance' && v.advanceId !== null) await this.advances.payIn(tx, ctx.companyId, v.advanceId, id, now);
    await tx.update(vendorPaymentVouchers).set({ status: 'paid', paidBy: ctx.actor.id, paidAt: now, paidOn: input.paidOn, paymentReference: reference.slice(0, 120), registerId, ledgerEntryId: entryId, rate, fxRegisterId, fxDifference: fromCents(gainCents), updatedAt: now }).where(eq(vendorPaymentVouchers.id, id));
    await this.event(tx, ctx.actor, id, 'paid', 'approved', 'paid', { data: { reference, paidOn: input.paidOn, registerId } });
    return { vendorId: v.vendorId, number: v.number ?? '', registerId, amount: v.cashAmount, currency: v.currency, reference, invoiceNos: invoices.map((i) => i.vendorInvoiceNo) };
  }

  /** Opens a sealed destination number. Set by the container so this service does not depend on the profile module. */
  private destinationOpener: ((blob: VendorBankAccountRow['accountSealed']) => string) | null = null;

  useDestinationOpener(open: (blob: VendorBankAccountRow['accountSealed']) => string): void {
    this.destinationOpener = open;
  }

  /**
   * What an approved voucher needs to be paid through M-Pesa: the provider and way of paying, the platform operation and its fields,
   * read from the destination that was fixed when the voucher was approved (never from the browser). Refuses what cannot go: a
   * voucher that is not approved, a releaser the three-people rule bars, an amount with cents, a destination that is no longer in
   * use, or a payout already sent. The voucher's own approval is the approval for the money.
   */
  async prepareMpesaPayout(ctx: FinanceContext, id: string) {
    return await this.db.transaction(async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (v.status !== 'approved') throw new FinanceError('WRONG_STATE', v.status === 'paid' ? 'This voucher has already been paid.' : 'Only an approved voucher can be paid.');
      const refusal = releaseRefusal(ctx.actor.id ?? '', v.createdBy, v.approvedBy, v.needsThree);
      if (refusal !== null) throw new FinanceError('THREE_PEOPLE', refusal);
      const { method, base } = await this.method(tx, ctx.companyId, v.methodId);
      if (method.kind !== 'mobile_money' || !has(method.providerId)) throw new FinanceError('NOT_MPESA', 'This voucher’s way of paying does not go through an M-Pesa connection. Pay it by hand and record it.');
      if (v.currency !== base || v.kind === 'advance') throw new FinanceError('NOT_MPESA', 'Only an invoice payment in the books’ own currency can be paid through M-Pesa.');
      const shillings = wholeShillings(v.cashAmount);
      if (shillings === null) throw new FinanceError('AMOUNT_NOT_WHOLE', 'M-Pesa pays whole shillings only, from 1 shilling up. Pay this voucher by hand.');
      const [account] = v.vendorBankAccountId === null ? [] : await tx.select().from(vendorBankAccounts).where(eq(vendorBankAccounts.id, v.vendorBankAccountId));
      if (account?.status !== 'active' || account.kind === 'bank') throw new FinanceError('DESTINATION_CHANGED', 'The M-Pesa destination this voucher was approved for is not in use. Cancel it and make a new voucher.');
      if (this.destinationOpener === null) throw new FinanceError('NOT_AVAILABLE', 'Sealed destinations cannot be opened here.');
      const plan = payoutPlan(account.kind, this.destinationOpener(account.accountSealed), account.reference, shillings, v.number ?? '');
      if (plan === null) throw new FinanceError('NOT_MPESA', 'That destination is not an M-Pesa one.');
      const live = await tx.select({ id: providerOperations.id }).from(providerOperations).where(and(eq(providerOperations.subjectType, 'vendor_payment'), eq(providerOperations.subjectId, id), inArray(providerOperations.status, ['queued', 'submitted', 'accepted', 'timed_out', 'in_doubt', 'succeeded'])));
      if (live.length > 0) throw new FinanceError('PAYOUT_IN_PROGRESS', 'A payment for this voucher has already been sent or is waiting for a check. See Payment activity.');
      const [count] = await tx.select({ n: sql<number>`count(*)::int` }).from(providerOperations).where(and(eq(providerOperations.subjectType, 'vendor_payment'), eq(providerOperations.subjectId, id)));
      await this.event(tx, ctx.actor, id, 'auto_payout_requested', 'approved', 'approved', { data: { methodId: method.id, amount: shillings, operation: plan.operation } });
      return { providerId: method.providerId, methodId: method.id, operation: plan.operation, input: plan.input, amount: shillings, number: v.number ?? '', attempt: (count?.n ?? 0) + 1 };
    });
  }

  /** The platform finished a payout for a voucher: if the money went, the voucher is recorded as paid with the receipt; if not, it says so and stays approved. */
  async onAutomaticPayoutFinished(op: { id: string; companyId: string; subjectId: string | null; status: string; platformReference: string | null; failureCode: string | null; failureReason: string | null }, now: Date = new Date()): Promise<void> {
    if (op.subjectId === null) return;
    const ctx: FinanceContext = { companyId: op.companyId, actor: { type: 'system', id: 'mpesa-payout' }, origin: { surface: 'payments/engine', action: 'vendor_auto_payout' } };
    const [v] = await this.db.select().from(vendorPaymentVouchers).where(eq(vendorPaymentVouchers.id, op.subjectId));
    if (v?.status !== 'approved') return;
    if (op.status === 'succeeded' && op.platformReference !== null && op.platformReference !== '') {
      try {
        const done = await this.db.transaction(async (tx) => await this.payIn(tx, ctx, v.id, { reference: op.platformReference ?? '', paidOn: businessDate(now) }, now));
        await this.tellPaid(done);
      } catch (error) {
        // The money is out. Say so loudly, so a person records it by hand with this reference.
        await this.db.transaction(async (tx) => {
          await this.event(tx, ctx.actor, v.id, 'auto_payout_paid_not_recorded', 'approved', 'approved', { data: { operation: op.id, reference: op.platformReference, reason: error instanceof Error ? error.message : 'unknown' } });
        });
      }
      return;
    }
    await this.db.transaction(async (tx) => {
      await this.event(tx, ctx.actor, v.id, 'auto_payout_not_paid', 'approved', 'approved', { data: { operation: op.id, status: op.status, code: op.failureCode, reason: op.failureReason } });
    });
  }

  /** A mistake in a paid voucher: the journal is reversed, the applications are undone, the invoices are open again. */
  async reverse(ctx: FinanceContext, id: string, reason: string, now: Date = new Date()): Promise<void> {
    const text = trimToNull(reason);
    if (!has(text)) throw new FinanceError('NOTE_REQUIRED', 'Say why the payment is reversed.');
    await this.db.transaction(async (tx) => {
      const v = await this.lock(tx, ctx.companyId, id);
      if (v.status !== 'paid' || v.registerId === null || v.ledgerEntryId === null) throw new FinanceError('NOT_PAID', 'Only a paid voucher can be reversed.');
      const today = businessDate(now);
      if (v.kind === 'on_account') {
        const [entry] = await tx.select({ open: vendorLedgerEntries.remainingAmount, amount: vendorLedgerEntries.amount }).from(vendorLedgerEntries).where(eq(vendorLedgerEntries.id, v.ledgerEntryId));
        if (entry !== undefined && toCents(entry.open) !== toCents(entry.amount)) throw new FinanceError('ON_ACCOUNT_APPLIED', 'Part of this payment was already set against an invoice. Undo that first.');
      }
      if (v.kind === 'advance') {
        const [entry] = await tx.select({ open: vendorLedgerEntries.remainingAmount, amount: vendorLedgerEntries.amount }).from(vendorLedgerEntries).where(eq(vendorLedgerEntries.id, v.ledgerEntryId));
        if (entry !== undefined && toCents(entry.open) !== toCents(entry.amount)) throw new FinanceError('ADVANCE_APPLIED', 'Part of this advance was already set against an invoice. Undo that first.');
        if (v.advanceId !== null) await this.advances.reopenIn(tx, ctx.companyId, v.advanceId, now);
      }
      await this.ledger.unapplyAll(tx, { companyId: ctx.companyId, entryId: v.ledgerEntryId, postingDate: today, reasonText: text.slice(0, 500), createdBy: ctx.actor.id });
      await this.ledger.undoWriteOffs(tx, { companyId: ctx.companyId, registerId: v.registerId, postingDate: today, reasonText: text.slice(0, 500), createdBy: ctx.actor.id });
      const [sent] = await tx.select().from(bankLedgerEntries).where(and(eq(bankLedgerEntries.documentId, id), eq(bankLedgerEntries.documentType, 'vendor_payment')));
      const afterwards = sent ?? null;
      await tx.update(withholdingCertificates).set({ status: 'cancelled', cancelReason: `Payment reversed: ${text.slice(0, 400)}`, cancelledAt: now }).where(and(eq(withholdingCertificates.voucherId, id), eq(withholdingCertificates.status, 'issued')));
      const reversal = await this.engine.reverse({ companyId: ctx.companyId, registerId: v.registerId, postingDate: today, reasonCode: 'vendor_payment_reversed', reasonText: text.slice(0, 500), origin: ctx.origin, permissions: ENGINE, tx });
      if (v.fxRegisterId !== null) await this.engine.reverse({ companyId: ctx.companyId, registerId: v.fxRegisterId, postingDate: today, reasonCode: 'vendor_payment_reversed', reasonText: text.slice(0, 500), origin: ctx.origin, permissions: ENGINE, tx });
      if (afterwards !== null) {
        await tx.insert(bankLedgerEntries).values({ companyId: ctx.companyId, bankAccountId: afterwards.bankAccountId, glAccountId: afterwards.glAccountId, postingDate: today, documentType: 'vendor_payment_reversal', documentNo: afterwards.documentNo, documentId: id, description: `Reversed: ${afterwards.description ?? ''}`.slice(0, 200), amount: fromCents(-toCents(afterwards.amount)), currency: afterwards.currency, registerId: reversal.registerId, reversesEntryId: afterwards.id, createdBy: ctx.actor.id });
      }
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

  /** Money owed back by the vendor that no invoice has used yet: payments made on account and booked credit memos, oldest first. */
  async openCredits(companyId: string, vendorId: string) {
    const rows = await this.db
      .select({ e: vendorLedgerEntries })
      .from(vendorLedgerEntries)
      .where(and(eq(vendorLedgerEntries.companyId, companyId), eq(vendorLedgerEntries.vendorId, vendorId), inArray(vendorLedgerEntries.documentType, ['payment', 'credit_memo']), sql`${vendorLedgerEntries.remainingAmount} < 0`))
      .orderBy(asc(vendorLedgerEntries.postingDate), asc(vendorLedgerEntries.createdAt));
    // A payment counts only while its voucher is paid (a reversed one has been closed already); a credit memo carries its own id.
    const voucherIds = rows.flatMap((r) => (r.e.documentType === 'payment' && r.e.documentId !== null ? [r.e.documentId] : []));
    const paid = voucherIds.length === 0 ? [] : await this.db.select({ id: vendorPaymentVouchers.id }).from(vendorPaymentVouchers).where(and(inArray(vendorPaymentVouchers.id, voucherIds), eq(vendorPaymentVouchers.status, 'paid')));
    const live = new Set(paid.map((p) => p.id));
    return rows
      .filter((r) => r.e.documentType === 'credit_memo' || (r.e.documentId !== null && live.has(r.e.documentId)))
      .map((r) => ({ entryId: r.e.id, documentId: r.e.documentId ?? '', kind: r.e.documentType, documentNo: r.e.documentNo, postingDate: r.e.postingDate, openCents: -toCents(r.e.remainingAmount) }));
  }

  /**
   * Sets payments made on account against a booked invoice, oldest first, as far as the invoice has something open: only the ledger
   * moves (the books already took the payment off what we owe when it was paid), and each voucher's history says so.
   */
  async applyCredit(ctx: FinanceContext, purchaseInvoiceId: string, now: Date = new Date()): Promise<{ appliedCents: number }> {
    return await this.db.transaction(async (tx) => {
      const [inv] = await tx.select().from(purchaseInvoices).where(and(eq(purchaseInvoices.companyId, ctx.companyId), eq(purchaseInvoices.id, purchaseInvoiceId)));
      if (inv === undefined) throw new FinanceError('NOT_FOUND', 'That booked invoice does not exist.');
      const credits = await this.openCredits(ctx.companyId, inv.vendorId);
      if (credits.length === 0) throw new FinanceError('NO_CREDIT', 'This vendor has no payment on account or credit memo waiting to be set against an invoice.');
      const today = businessDate(now);
      let applied = 0;
      for (const credit of credits) {
        const [invEntry] = await tx.select({ remaining: vendorLedgerEntries.remainingAmount }).from(vendorLedgerEntries).where(eq(vendorLedgerEntries.id, inv.ledgerEntryId));
        const open = invEntry === undefined ? 0 : toCents(invEntry.remaining);
        const cents = Math.min(credit.openCents, open);
        if (cents <= 0) break;
        await this.ledger.apply(tx, { companyId: ctx.companyId, vendorId: inv.vendorId, creditEntryId: credit.entryId, invoiceEntryId: inv.ledgerEntryId, amountCents: cents, postingDate: today, createdBy: ctx.actor.id });
        if (credit.kind === 'credit_memo') await tx.insert(vendorCreditMemoEvents).values({ memoId: credit.documentId, event: 'credit_applied', data: { invoice: inv.number, amount: fromCents(cents) }, actorType: ctx.actor.type, actorId: ctx.actor.id });
        else await this.event(tx, ctx.actor, credit.documentId, 'credit_applied', null, null, { data: { invoice: inv.number, amount: fromCents(cents) } });
        applied += cents;
      }
      if (applied === 0) throw new FinanceError('NOTHING_TO_APPLY', 'The invoice has nothing left to pay.');
      return { appliedCents: applied };
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
      lines: lines.map((x) => ({ purchaseInvoiceId: x.l.purchaseInvoiceId, number: x.number, vendorInvoiceNo: x.vendorInvoiceNo, invoiceTotal: x.total, amount: x.l.amount, closeRemainder: x.l.closeRemainder, discount: x.l.discount, tolerance: x.l.tolerance, withholding: x.l.withholding })),
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
    const certRows = ids.length === 0 ? [] : await this.db.select({ voucherId: withholdingCertificates.voucherId, id: withholdingCertificates.id }).from(withholdingCertificates).where(and(inArray(withholdingCertificates.voucherId, ids), eq(withholdingCertificates.status, 'issued')));
    const certs = new Map(certRows.map((c) => [c.voucherId, c.id]));
    const lines = ids.length === 0 ? [] : await this.db.select({ voucherId: vendorPaymentVoucherLines.voucherId, vendorInvoiceNo: purchaseInvoices.vendorInvoiceNo, amount: vendorPaymentVoucherLines.amount }).from(vendorPaymentVoucherLines).innerJoin(purchaseInvoices, eq(purchaseInvoices.id, vendorPaymentVoucherLines.purchaseInvoiceId)).where(inArray(vendorPaymentVoucherLines.voucherId, ids));
    const last = page.at(-1);
    return {
      rows: page.map((p) => ({ id: p.v.id, number: p.v.number ?? '', kind: p.v.kind, paidOn: p.v.paidOn ?? '', reference: p.v.paymentReference ?? '', amount: p.v.cashAmount, settled: p.v.amount, withheld: p.v.withholdingAmount, discount: p.v.discountAmount, certificateId: certs.get(p.v.id) ?? null, currency: p.v.currency, destination: p.v.destination, invoices: lines.filter((l) => l.voucherId === p.v.id).map((l) => ({ vendorInvoiceNo: l.vendorInvoiceNo, amount: l.amount })) })),
      next: found.length > take && last !== undefined ? { stamp: last.stamp, id: last.v.id } : null,
    };
  }
}
