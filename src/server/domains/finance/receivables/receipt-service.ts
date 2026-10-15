import { randomUUID } from 'node:crypto';
import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  bankAccounts,
  bankLedgerEntries,
  customerDetailedEntries,
  customerLedgerEntries,
  customerReceipts,
  customers,
  financeAttachments,
  financeSettings,
  paymentMethods,
  receiptEvents,
  users,
  type CustomerReceiptRow,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { TransactionLedgerService } from '@/server/domains/transactions/ledger-service';
import { checkReceiptAgainstMethod, fromCents, toCents, type PlannedApplication } from '../domain/receivables';
import type { PostingRequest } from '../domain/types';
import { NO_SPECIAL_PERMISSIONS, type PostingEngine, type PostingPermissions, type Tx } from '../engine';
import { FinanceError, type FinanceContext } from '../errors';
import type { PostingSetupService } from '../posting-setup-service';
import type { CreditPolicyService } from './credit-policy-service';
import type { CustomerLedgerService } from './customer-ledger-service';
import type { WalletService } from './wallet-service';

import { filledStrings, has, orElse, trimToNull } from '@/lib/values';

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export interface ReceiptInput {
  customerId: string;
  paymentMethodId: string;
  amount: string;
  currency?: string;
  rate?: string;
  paymentDate?: string;
  postingDate?: string;
  externalReference?: string | null;
  payerName?: string | null;
  counterparty?: Record<string, string>;
  narration?: string | null;
  branchId?: string | null;
  source?: CustomerReceiptRow['source'];
  sourceRef?: string | null;
  orderId?: string | null;
  idempotencyKey?: string | null;
  /** An advance with no invoice: the whole amount goes to the customer's wallet when posted. */
  isDeposit?: boolean;
}

export type AllocateMode = 'none' | 'oldest_first' | PlannedApplication[];

export interface ReceiptListFilter {
  status?: CustomerReceiptRow['status'];
  customerId?: string;
  q?: string;
  /** created_at cursor from the previous page. */
  before?: string;
  limit?: number;
}

/**
 * Money received from customers. A receipt is drafted, then posted once: posting writes the
 * customer ledger entry, the bank ledger entry, the legacy transaction-ledger credit, and (from
 * the go-live date) the general-ledger entries, all in one transaction. After that it only moves
 * through apply / unapply, the cheque steps, or a reasoned reversal.
 */
export class ReceiptService {
  private readonly legacyLedger: TransactionLedgerService;

  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: PostingEngine,
    private readonly ledger: CustomerLedgerService,
    private readonly numbering: NumberSeriesService,
    private readonly reasons: ReasonCodes,
    private readonly setup: PostingSetupService,
    private readonly wallets: WalletService,
    private readonly policies: CreditPolicyService,
  ) {
    this.legacyLedger = new TransactionLedgerService(db);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async event(
    tx: Tx,
    ctx: FinanceContext,
    receiptId: string,
    event: string,
    from: string | null,
    to: string | null,
    extra: { reasonCode?: string | null; reasonText?: string | null; data?: Record<string, unknown> } = {},
  ) {
    await tx.insert(receiptEvents).values({
      receiptId,
      event,
      fromStatus: from,
      toStatus: to,
      reasonCode: extra.reasonCode ?? null,
      reasonText: extra.reasonText ?? null,
      data: extra.data ?? {},
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      origin: ctx.origin,
    });
  }

  private async lock(tx: Tx, ctx: FinanceContext, id: string): Promise<CustomerReceiptRow> {
    const [r] = await tx
      .select()
      .from(customerReceipts)
      .where(and(eq(customerReceipts.companyId, ctx.companyId), eq(customerReceipts.id, id)))
      .for('update');
    if (!r) throw new FinanceError('NOT_FOUND', 'That receipt does not exist.');
    return r;
  }

  private async glLive(tx: Tx | DrizzleDb, companyId: string, postingDate: string) {
    const [s] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, companyId)).limit(1);
    if (!s) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
    return { settings: s, live: s.salesGlGoLive !== null && postingDate >= s.salesGlGoLive };
  }

  private customerGroup(settingsDefault: string, customerGroup: string | null) {
    return Promise.resolve(customerGroup ?? settingsDefault);
  }

  private async assertDate(tx: Tx, companyId: string, date: string, perms: PostingPermissions) {
    const issues = await this.engine.dateIssues(tx, companyId, date, perms);
    if (issues.length > 0) throw new FinanceError(issues[0].code, issues.map((i) => i.message).join(' '), issues);
  }

  private async evidenceCount(tx: Tx | DrizzleDb, receiptId: string): Promise<number> {
    const [row] = await tx
      .select({ n: sql<number>`count(*)::int` })
      .from(financeAttachments)
      .where(and(eq(financeAttachments.subjectType, 'customer_receipt'), eq(financeAttachments.subjectId, receiptId)));
    return row?.n ?? 0;
  }

  private chain(branchId: string | null) {
    return branchId ?? 'general';
  }

  // ── create / cancel ──────────────────────────────────────────────────────

  async create(ctx: FinanceContext, input: ReceiptInput): Promise<{ id: string; number: string }> {
    const id = randomUUID();
    return await this.db.transaction(async (tx) => {
      if (has(input.idempotencyKey)) {
        const [dup] = await tx
          .select({ id: customerReceipts.id, number: customerReceipts.number })
          .from(customerReceipts)
          .where(and(eq(customerReceipts.companyId, ctx.companyId), eq(customerReceipts.idempotencyKey, input.idempotencyKey)));
        if (dup) return dup;
      }
      const [customer] = await tx
        .select()
        .from(customers)
        .where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
      if (!customer) throw new FinanceError('CUSTOMER_NOT_FOUND', 'Choose the customer who paid.');
      if (!customer.isActive) throw new FinanceError('CUSTOMER_INACTIVE', `${customer.name} is inactive.`);

      const [row] = await tx
        .select({ method: paymentMethods, bank: bankAccounts })
        .from(paymentMethods)
        .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
        .where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, input.paymentMethodId)));
      if (!row) throw new FinanceError('METHOD_NOT_FOUND', 'Choose how the customer paid.');
      const { method, bank } = row;
      if (bank.blocked) throw new FinanceError('BANK_BLOCKED', `${bank.code} is blocked, so this method cannot take money.`);
      if (has(method.branchId) && has(input.branchId) && input.branchId !== method.branchId) {
        throw new FinanceError('METHOD_BRANCH', `${method.name} belongs to another branch than the one this receipt is for.`);
      }
      const branchId = input.branchId ?? method.branchId ?? null;

      let cents: number;
      try {
        cents = toCents(input.amount);
      } catch {
        throw new FinanceError('AMOUNT_INVALID', 'The amount must be a number with at most 2 decimal places.');
      }
      const reference = trimToNull(input.externalReference);
      const counterparty = filledStrings(input.counterparty);
      const issues = checkReceiptAgainstMethod(
        { ...method, kind: method.kind, limits: method.limits, usableFor: method.usableFor },
        { amountCents: cents, externalReference: reference, counterparty, evidenceCount: 0 },
        false,
      );
      if (issues.length > 0) throw new FinanceError(issues[0].code, issues.map((i) => i.message).join(' '), issues);

      const currency = (input.currency ?? bank.currency).toUpperCase();
      if (currency !== bank.currency) {
        throw new FinanceError('CURRENCY_MISMATCH', `${bank.code} holds ${bank.currency}; a ${currency} receipt needs a ${currency} account.`);
      }
      const { settings } = await this.glLive(tx, ctx.companyId, input.postingDate ?? businessDate());
      let rate = '1';
      if (currency !== settings.baseCurrency) {
        rate = (input.rate ?? '').trim();
        if (!has(rate) || !(Number(rate) > 0)) {
          throw new FinanceError('RATE_REQUIRED', `Enter the exchange rate from ${currency} to ${settings.baseCurrency}.`);
        }
      }
      const today = businessDate();
      const paymentDate = input.paymentDate ?? today;
      const postingDate = input.postingDate ?? paymentDate;
      if (!DATE.test(paymentDate) || !DATE.test(postingDate)) throw new FinanceError('DATE_INVALID', 'Enter valid dates.');
      if (paymentDate > today) throw new FinanceError('DATE_FUTURE', 'The payment date cannot be in the future.');

      if (input.isDeposit === true) {
        // An advance must have somewhere to go: refuse now, not at posting.
        const policy = await this.policies.forCustomer(tx, ctx.companyId, customer.id);
        if (!policy.walletEnabled) throw new FinanceError('WALLET_OFF', `The ${policy.label.toLowerCase()} is not switched on, so an advance deposit has nowhere to go (Finance → Wallet policy).`);
        if (!policy.allowDeposits) throw new FinanceError('DEPOSITS_OFF', `Advance deposits into the ${policy.label.toLowerCase()} are not allowed.`);
      }
      if (has(reference)) {
        const [dup] = await tx
          .select({ number: customerReceipts.number })
          .from(customerReceipts)
          .where(
            and(
              eq(customerReceipts.companyId, ctx.companyId),
              eq(customerReceipts.paymentMethodId, method.id),
              eq(customerReceipts.externalReference, reference),
              sql`${customerReceipts.status} IN ('draft','posted')`,
            ),
          );
        if (dup) throw new FinanceError('DUPLICATE_REFERENCE', `Reference ${reference} is already recorded on receipt ${dup.number}.`);
      }

      const { number } = await this.numbering.assign(
        'customer_payment',
        {
          companyId: ctx.companyId,
          branchId: branchId ?? undefined,
          date: businessDate(),
          document: { kind: 'customer_payment', id },
          actor: ctx.actor,
        },
        tx,
      );
      await tx.insert(customerReceipts).values({
        id,
        companyId: ctx.companyId,
        number,
        customerId: customer.id,
        paymentMethodId: method.id,
        bankAccountId: bank.id,
        amount: fromCents(cents),
        currency,
        rate,
        paymentDate,
        postingDate,
        externalReference: reference,
        payerName: trimToNull(input.payerName),
        counterparty,
        narration: trimToNull(input.narration),
        branchId,
        source: input.source ?? 'manual',
        sourceRef: input.sourceRef ?? null,
        orderId: input.orderId ?? null,
        isDeposit: input.isDeposit ?? false,
        idempotencyKey: input.idempotencyKey ?? null,
        createdBy: ctx.actor.id ?? 'system',
      });
      await this.event(tx, ctx, id, 'created', null, 'draft', { data: { amount: fromCents(cents), method: method.code } });
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'customer_receipt', id },
          action: 'finance.receipt_created',
          actor: ctx.actor,
          to: 'draft',
          inputs: { origin: ctx.origin, customerId: customer.id, method: method.code, source: input.source ?? 'manual' },
          outcome: { number, amount: fromCents(cents), currency },
        },
        tx,
      );
      return { id, number };
    });
  }

  async cancelDraft(ctx: FinanceContext, id: string, reason: { code: string; text?: string | null }) {
    const r = await this.reasons.require(ctx.companyId, reason, 'receipt');
    await this.db.transaction(async (tx) => {
      const receipt = await this.lock(tx, ctx, id);
      if (receipt.status !== 'draft') throw new FinanceError('NOT_DRAFT', 'Only a draft receipt can be cancelled; reverse a posted one.');
      await tx.update(customerReceipts).set({ status: 'cancelled', updatedAt: new Date() }).where(eq(customerReceipts.id, id));
      await this.event(tx, ctx, id, 'cancelled', 'draft', 'cancelled', { reasonCode: r.code, reasonText: r.text });
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'customer_receipt', id },
          action: 'finance.receipt_cancelled',
          actor: ctx.actor,
          from: 'draft',
          to: 'cancelled',
          reason: r,
          inputs: { origin: ctx.origin },
        },
        tx,
      );
    });
  }

  // ── post ─────────────────────────────────────────────────────────────────

  async post(
    ctx: FinanceContext,
    id: string,
    opts: { allocate?: AllocateMode; permissions?: PostingPermissions } = {},
  ): Promise<{ number: string; appliedCents: number; registerId: string | null; glPosted: boolean }> {
    const perms = opts.permissions ?? NO_SPECIAL_PERMISSIONS;
    return await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx, id);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', `Receipt ${r.number} is already ${r.status}.`);

      const [row] = await tx
        .select({ method: paymentMethods, bank: bankAccounts })
        .from(paymentMethods)
        .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
        .where(eq(paymentMethods.id, r.paymentMethodId));
      if (!row) throw new FinanceError('METHOD_NOT_FOUND', 'The payment method no longer exists.');
      const { method, bank } = row;
      if (bank.blocked) throw new FinanceError('BANK_BLOCKED', `${bank.code} is blocked.`);
      const cents = toCents(r.amount);
      const issues = checkReceiptAgainstMethod(
        { ...method, limits: method.limits, usableFor: method.usableFor },
        {
          amountCents: cents,
          externalReference: r.externalReference,
          counterparty: r.counterparty,
          evidenceCount: await this.evidenceCount(tx, id),
        },
        true,
      );
      if (issues.length > 0) throw new FinanceError(issues[0].code, issues.map((i) => i.message).join(' '), issues);
      await this.assertDate(tx, ctx.companyId, r.postingDate, perms);

      const [customer] = await tx.select().from(customers).where(eq(customers.id, r.customerId));
      if (!customer) throw new FinanceError('CUSTOMER_NOT_FOUND', 'The customer no longer exists.');
      const { settings, live } = await this.glLive(tx, ctx.companyId, r.postingDate);
      const actorId = ctx.actor.id;

      // GL first: if the setup is incomplete the whole receipt fails before anything else is written.
      let registerId: string | null = null;
      if (live) {
        const group = await this.customerGroup(settings.defaultCustomerGroup, customer.postingGroupCode);
        const receivables = await this.setup.resolveCustomer(ctx.companyId, group, 'receivables').catch((e: unknown) => {
          throw new FinanceError('POSTING_SETUP_MISSING', e instanceof Error ? e.message : 'Posting setup is incomplete.');
        });
        const req: PostingRequest = {
          companyId: ctx.companyId,
          idempotencyKey: `receipt:${id}:post`,
          postingDate: r.postingDate,
          documentDate: r.paymentDate,
          documentType: 'customer_receipt',
          documentNo: r.number,
          description: `Receipt ${r.number} from ${customer.name}`,
          currency: r.currency,
          rate: r.rate,
          rateSource: r.currency === settings.baseCurrency ? 'base' : 'manual',
          lines: [
            { accountId: method.glAccountId, debit: r.amount, credit: '0', description: `${method.name} ${r.externalReference ?? ''}`.trim(), sourceLedger: 'bank', sourceEntryId: bank.id },
            { accountId: receivables.accountId, debit: '0', credit: r.amount, description: `Receipt ${r.number}`, sourceLedger: 'customer', sourceEntryId: customer.id },
          ],
          chainKey: this.chain(r.branchId),
          branchId: r.branchId,
          origin: ctx.origin,
          source: { type: 'customer_receipt', id },
          postedBy: 'engine',
        };
        const posted = await this.engine.post(req, perms, tx);
        registerId = posted.registerId;
      }

      const ledgerEntryId = await this.ledger.addEntry(tx, {
        companyId: ctx.companyId,
        customerId: customer.id,
        documentType: 'payment',
        documentNo: r.number,
        documentId: id,
        orderId: r.orderId,
        description: `${method.name}${has(r.externalReference) ? ` ${r.externalReference}` : ''}`,
        amountCents: -cents,
        currency: r.currency,
        postingDate: r.postingDate,
        registerId,
        createdBy: actorId,
      });
      await tx.insert(bankLedgerEntries).values({
        companyId: ctx.companyId,
        bankAccountId: bank.id,
        postingDate: r.postingDate,
        documentType: 'customer_receipt',
        documentNo: r.number,
        documentId: id,
        glAccountId: method.glAccountId,
        description: `${customer.name} — ${method.name}`,
        amount: fromCents(cents),
        currency: r.currency,
        registerId,
        createdBy: actorId,
      });
      // The older transaction ledger is still read by reconciliation; keep it in step (idempotent).
      await this.legacyLedger.post(
        {
          companyId: ctx.companyId,
          customerId: customer.id,
          orderId: r.orderId,
          documentType: 'payment',
          documentNo: r.number,
          description: 'Customer payment',
          direction: 'credit',
          amount: cents / 100,
          currency: r.currency,
          transactionReference: r.externalReference ?? r.number,
          idempotencyKey: `receipt:${id}`,
        },
        tx,
      );
      await tx
        .update(customerReceipts)
        .set({
          status: 'posted',
          chequeStatus: method.kind === 'cheque' ? 'received' : null,
          ledgerEntryId,
          registerId,
          postedAt: new Date(),
          postedBy: actorId,
          updatedAt: new Date(),
        })
        .where(eq(customerReceipts.id, id));
      await this.event(tx, ctx, id, 'posted', 'draft', 'posted', { data: { gl: live, registerId } });

      let applied = 0;
      const allocate = opts.allocate ?? 'none';
      if (allocate !== 'none') {
        try {
          const res = await this.ledger.applyIn(tx, ctx, {
            customerId: customer.id,
            creditEntryId: ledgerEntryId,
            applications: allocate,
            postingDate: r.postingDate,
            createdBy: actorId,
          });
          applied = res.appliedCents;
          await this.event(tx, ctx, id, 'applied', 'posted', 'posted', { data: { total: fromCents(applied), applicationId: res.applicationId } });
        } catch (e) {
          // Automatic allocation with nothing open is not a failure: the money stays unapplied.
          if (!(allocate === 'oldest_first' && e instanceof FinanceError && e.code === 'NOTHING_TO_APPLY')) throw e;
        }
      }
      // Money paid beyond what is owed: into the wallet when the policy says so (an advance always).
      const afterApply = has(ledgerEntryId) ? await this.wallets.receiptUnappliedIn(tx, ledgerEntryId) : 0;
      if (afterApply > 0) {
        const policy = await this.policies.forCustomer(tx, ctx.companyId, customer.id, r.postingDate);
        if (r.isDeposit || (policy.walletEnabled && policy.overpaymentDefault === 'wallet')) {
          const posted = { ...r, status: 'posted' as const, ledgerEntryId, registerId };
          try {
            await tx.transaction((sp) => this.wallets.moveReceiptIn(sp, ctx, posted, { permissions: perms }));
          } catch (e) {
            // An advance that cannot be kept fails the receipt; an overpayment that cannot just stays unapplied.
            if (r.isDeposit || !(e instanceof FinanceError)) throw e;
            await this.event(tx, ctx, id, 'wallet_move_skipped', 'posted', 'posted', { reasonText: e.message });
          }
        }
      }
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'customer_receipt', id },
          action: 'finance.receipt_posted',
          actor: ctx.actor,
          from: 'draft',
          to: 'posted',
          inputs: { origin: ctx.origin, method: method.code, bank: bank.code, source: r.source },
          outcome: { number: r.number, amount: r.amount, currency: r.currency, applied: fromCents(applied), gl: live, registerId },
        },
        tx,
      );
      return { number: r.number, appliedCents: applied, registerId, glPosted: live };
    });
  }

  // ── apply / unapply ──────────────────────────────────────────────────────

  async apply(ctx: FinanceContext, id: string, applications: PlannedApplication[] | 'oldest_first') {
    return await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx, id);
      if (r.status !== 'posted' || !has(r.ledgerEntryId)) throw new FinanceError('NOT_POSTED', 'Only a posted receipt can be applied.');
      if (r.chequeStatus === 'bounced') throw new FinanceError('CHEQUE_BOUNCED', 'This cheque bounced.');
      const res = await this.ledger.applyIn(tx, ctx, {
        customerId: r.customerId,
        creditEntryId: r.ledgerEntryId,
        applications,
        postingDate: businessDate(),
        createdBy: ctx.actor.id,
      });
      await this.event(tx, ctx, id, 'applied', 'posted', 'posted', { data: { total: fromCents(res.appliedCents), applicationId: res.applicationId } });
      return res;
    });
  }

  async unapply(ctx: FinanceContext, receiptId: string, applicationId: string, reason: { code: string; text?: string | null }) {
    const rs = await this.reasons.require(ctx.companyId, reason, 'receipt');
    return await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx, receiptId);
      if (!has(r.ledgerEntryId)) throw new FinanceError('NOT_POSTED', 'That receipt has not been posted.');
      const [belongs] = await tx
        .select({ id: customerDetailedEntries.id })
        .from(customerDetailedEntries)
        .where(and(eq(customerDetailedEntries.applicationId, applicationId), eq(customerDetailedEntries.ledgerEntryId, r.ledgerEntryId)))
        .limit(1);
      if (!belongs) throw new FinanceError('NOT_FOUND', 'That application does not belong to this receipt.');
      const res = await this.ledger.unapplyIn(tx, ctx, {
        applicationId,
        reasonCode: rs.code,
        reasonText: rs.text,
        postingDate: businessDate(),
        createdBy: ctx.actor.id,
      });
      await this.event(tx, ctx, receiptId, 'unapplied', 'posted', 'posted', { reasonCode: rs.code, reasonText: rs.text, data: { applicationId, restored: fromCents(res.restoredCents) } });
      return res;
    });
  }

  /** Application ids on a receipt that are still in force. */
  private async activeApplications(tx: Tx | DrizzleDb, ledgerEntryId: string): Promise<string[]> {
    const res = await tx.execute<{ application_id: string }>(sql`
      SELECT DISTINCT d.application_id FROM customer_detailed_entries d
      WHERE d.ledger_entry_id = ${ledgerEntryId}::uuid AND d.entry_type = 'application'
        AND NOT EXISTS (SELECT 1 FROM customer_detailed_entries u WHERE u.unapplies_application_id = d.application_id)`);
    return [...res].map((r) => r.application_id);
  }

  // ── reverse / cheque ─────────────────────────────────────────────────────

  private async reverseIn(
    tx: Tx,
    ctx: FinanceContext,
    r: CustomerReceiptRow,
    opts: { reasonCode: string; reasonText: string | null; postingDate: string; perms: PostingPermissions; unapplyFirst: boolean; chequeStatus?: 'bounced' },
  ) {
    if (r.status !== 'posted' || !has(r.ledgerEntryId)) throw new FinanceError('NOT_POSTED', 'Only a posted receipt can be reversed.');
    const active = await this.activeApplications(tx, r.ledgerEntryId);
    if (active.length > 0) {
      if (!opts.unapplyFirst) {
        throw new FinanceError('HAS_APPLICATIONS', `This receipt is applied to ${active.length} ${active.length === 1 ? 'application' : 'applications'}. Undo them first.`);
      }
      for (const applicationId of active) {
        await this.ledger.unapplyIn(tx, ctx, {
          applicationId,
          reasonCode: opts.reasonCode,
          reasonText: opts.reasonText,
          postingDate: opts.postingDate,
          createdBy: ctx.actor.id,
        });
      }
    }
    await this.assertDate(tx, ctx.companyId, opts.postingDate, opts.perms);
    // Whatever went to the wallet must still be there; it comes back before the receipt is closed.
    await this.wallets.returnReceiptCreditIn(tx, ctx, r, { code: opts.reasonCode, text: opts.reasonText });
    await this.ledger.closeCreditIn(tx, ctx, r.ledgerEntryId, {
      postingDate: opts.postingDate,
      reasonCode: opts.reasonCode,
      reasonText: opts.reasonText,
      createdBy: ctx.actor.id,
    });
    // Take the money back out of whichever account(s) it now sits in.
    const sits = await tx.execute<{ bank_account_id: string; gl_account_id: string; total: string; currency: string }>(sql`
      SELECT bank_account_id, gl_account_id, SUM(amount) AS total, MAX(currency) AS currency FROM bank_ledger_entries
      WHERE document_id = ${r.id}::uuid GROUP BY bank_account_id, gl_account_id HAVING SUM(amount) <> 0`);
    for (const s of sits) {
      await tx.insert(bankLedgerEntries).values({
        companyId: ctx.companyId,
        bankAccountId: s.bank_account_id,
        glAccountId: s.gl_account_id,
        postingDate: opts.postingDate,
        documentType: 'customer_receipt_reversal',
        documentNo: r.number,
        documentId: r.id,
        description: `Reversal of ${r.number}`,
        amount: fromCents(-toCents(Number(s.total).toFixed(2))),
        currency: s.currency,
        createdBy: ctx.actor.id,
      });
    }
    await this.legacyLedger.post(
      {
        companyId: ctx.companyId,
        customerId: r.customerId,
        orderId: r.orderId,
        documentType: 'payment',
        documentNo: r.number,
        description: 'Customer payment reversed',
        direction: 'debit',
        amount: toCents(r.amount) / 100,
        currency: r.currency,
        transactionReference: r.externalReference ?? r.number,
        idempotencyKey: `receipt-reversal:${r.id}`,
      },
      tx,
    );
    // The books: reverse the registers this receipt made (posting, and clearing if it cleared).
    const regs = await tx.execute<{ id: string }>(sql`
      SELECT id FROM ledger_registers
      WHERE company_id = ${ctx.companyId}::uuid AND source_type = 'customer_receipt' AND source_id = ${r.id}
        AND reversal_of_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM register_reversals rr WHERE rr.original_id = ledger_registers.id)
      ORDER BY seq DESC`);
    for (const reg of regs) {
      await this.engine.reverse({
        companyId: ctx.companyId,
        registerId: reg.id,
        postingDate: opts.postingDate,
        reasonCode: opts.reasonCode,
        reasonText: opts.reasonText,
        origin: ctx.origin,
        permissions: opts.perms,
        tx,
      });
    }
    await tx
      .update(customerReceipts)
      .set({ status: 'reversed', chequeStatus: opts.chequeStatus ?? r.chequeStatus, updatedAt: new Date() })
      .where(eq(customerReceipts.id, r.id));
  }

  async reverse(
    ctx: FinanceContext,
    id: string,
    reason: { code: string; text?: string | null },
    opts: { postingDate?: string; permissions?: PostingPermissions } = {},
  ) {
    const rs = await this.reasons.require(ctx.companyId, reason, 'receipt');
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx, id);
      await this.reverseIn(tx, ctx, r, {
        reasonCode: rs.code,
        reasonText: rs.text,
        postingDate: opts.postingDate ?? businessDate(),
        perms: opts.permissions ?? NO_SPECIAL_PERMISSIONS,
        unapplyFirst: false,
      });
      await this.event(tx, ctx, id, 'reversed', 'posted', 'reversed', { reasonCode: rs.code, reasonText: rs.text });
      await this.decisions.record(
        {
          companyId: ctx.companyId,
          subject: { type: 'customer_receipt', id },
          action: 'finance.receipt_reversed',
          actor: ctx.actor,
          from: 'posted',
          to: 'reversed',
          reason: rs,
          inputs: { origin: ctx.origin },
          outcome: { number: r.number, amount: r.amount },
        },
        tx,
      );
    });
  }

  private async requireCheque(tx: Tx, ctx: FinanceContext, id: string, from: CustomerReceiptRow['chequeStatus'][]) {
    const r = await this.lock(tx, ctx, id);
    if (r.status !== 'posted') throw new FinanceError('NOT_POSTED', 'Only a posted cheque can be moved on.');
    if (!has(r.chequeStatus) || !from.includes(r.chequeStatus)) {
      throw new FinanceError('CHEQUE_STATE', `A cheque that is "${r.chequeStatus ?? 'not a cheque'}" cannot do that.`);
    }
    return r;
  }

  /** Payment methods a cheque can be deposited through (a bank account and the G/L account it posts to). */
  async chequeDepositMethods(companyId: string) {
    const rows = await this.db
      .select({ method: paymentMethods, bank: bankAccounts })
      .from(paymentMethods)
      .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
      .where(and(eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true), eq(bankAccounts.kind, 'bank'), eq(bankAccounts.blocked, false)));
    return rows.map((r) => ({ id: r.method.id, name: r.method.name, bankCode: r.bank.code, bankName: r.bank.name, currency: r.bank.currency, branchId: r.method.branchId }));
  }

  async depositCheque(ctx: FinanceContext, id: string, input: { depositMethodId: string; date?: string }) {
    await this.db.transaction(async (tx) => {
      const r = await this.requireCheque(tx, ctx, id, ['received']);
      const [row] = await tx
        .select({ method: paymentMethods, bank: bankAccounts })
        .from(paymentMethods)
        .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
        .where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, input.depositMethodId)));
      const bank = row?.bank;
      if (!row || !bank || bank.blocked || !row.method.enabled) throw new FinanceError('BANK_NOT_FOUND', 'Choose the payment method of the bank account the cheque is deposited into.');
      if (bank.kind !== 'bank') throw new FinanceError('BANK_KIND', 'A cheque is deposited into a bank account.');
      if (bank.currency !== r.currency) throw new FinanceError('CURRENCY_MISMATCH', `${bank.code} holds ${bank.currency}, the cheque is in ${r.currency}.`);
      const date = input.date ?? businessDate();
      await tx
        .update(customerReceipts)
        .set({ chequeStatus: 'deposited', counterparty: { ...r.counterparty, depositBankAccountId: bank.id, depositMethodId: row.method.id, depositedOn: date }, updatedAt: new Date() })
        .where(eq(customerReceipts.id, id));
      await this.event(tx, ctx, id, 'cheque_deposited', 'received', 'deposited', { data: { bank: bank.code, method: row.method.name, date } });
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'customer_receipt', id }, action: 'finance.cheque_deposited', actor: ctx.actor, from: 'received', to: 'deposited', inputs: { origin: ctx.origin, bank: bank.code, method: row.method.name, date } },
        tx,
      );
    });
  }

  async clearCheque(ctx: FinanceContext, id: string, input: { date?: string; permissions?: PostingPermissions } = {}) {
    const perms = input.permissions ?? NO_SPECIAL_PERMISSIONS;
    await this.db.transaction(async (tx) => {
      const r = await this.requireCheque(tx, ctx, id, ['deposited']);
      const date = input.date ?? businessDate();
      const bankId = r.counterparty.depositBankAccountId;
      if (!has(bankId)) throw new FinanceError('CHEQUE_STATE', 'Record the deposit before clearing.');
      // A cheque deposited before methods carried the G/L account only knows the bank account: use one of its methods.
      let depositMethodId = r.counterparty.depositMethodId;
      if (!has(depositMethodId)) {
        const [any] = await tx.select({ id: paymentMethods.id }).from(paymentMethods).where(eq(paymentMethods.balancingBankAccountId, bankId)).orderBy(paymentMethods.sortOrder).limit(1);
        depositMethodId = any?.id;
      }
      if (!has(depositMethodId)) throw new FinanceError('CHEQUE_STATE', 'No payment method posts to the bank account this cheque was deposited into. Add one first.');
      const [[dest], [transit], [destMethod], [transitMethod]] = await Promise.all([
        tx.select().from(bankAccounts).where(eq(bankAccounts.id, bankId)),
        tx.select().from(bankAccounts).where(eq(bankAccounts.id, r.bankAccountId)),
        tx.select().from(paymentMethods).where(eq(paymentMethods.id, depositMethodId)),
        tx.select().from(paymentMethods).where(eq(paymentMethods.id, r.paymentMethodId)),
      ]);
      if (!dest || !transit || !destMethod || !transitMethod) throw new FinanceError('BANK_NOT_FOUND', 'The bank account for this cheque no longer exists.');
      await this.assertDate(tx, ctx.companyId, date, perms);
      const { settings, live } = await this.glLive(tx, ctx.companyId, date);
      let registerId: string | null = null;
      if (live) {
        const posted = await this.engine.post(
          {
            companyId: ctx.companyId,
            idempotencyKey: `receipt:${id}:clear`,
            postingDate: date,
            documentType: 'cheque_clearing',
            documentNo: r.number,
            description: `Cheque ${r.counterparty.chequeNo ?? ''} cleared (${r.number})`,
            currency: r.currency,
            rate: r.rate,
            rateSource: r.currency === settings.baseCurrency ? 'base' : 'manual',
            lines: [
              { accountId: destMethod.glAccountId, debit: r.amount, credit: '0', sourceLedger: 'bank', sourceEntryId: dest.id },
              { accountId: transitMethod.glAccountId, debit: '0', credit: r.amount, sourceLedger: 'bank', sourceEntryId: transit.id },
            ],
            chainKey: this.chain(r.branchId),
            branchId: r.branchId,
            origin: ctx.origin,
            source: { type: 'customer_receipt', id },
            postedBy: 'engine',
          },
          perms,
          tx,
        );
        registerId = posted.registerId;
      }
      await tx.insert(bankLedgerEntries).values([
        { companyId: ctx.companyId, bankAccountId: transit.id, glAccountId: transitMethod.glAccountId, postingDate: date, documentType: 'cheque_clearing', documentNo: r.number, documentId: id, description: 'Cheque cleared', amount: fromCents(-toCents(r.amount)), currency: r.currency, registerId, createdBy: ctx.actor.id },
        { companyId: ctx.companyId, bankAccountId: dest.id, glAccountId: destMethod.glAccountId, postingDate: date, documentType: 'cheque_clearing', documentNo: r.number, documentId: id, description: 'Cheque cleared', amount: r.amount, currency: r.currency, registerId, createdBy: ctx.actor.id },
      ]);
      await tx.update(customerReceipts).set({ chequeStatus: 'cleared', updatedAt: new Date() }).where(eq(customerReceipts.id, id));
      await this.event(tx, ctx, id, 'cheque_cleared', 'deposited', 'cleared', { data: { date, gl: live, registerId } });
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'customer_receipt', id }, action: 'finance.cheque_cleared', actor: ctx.actor, from: 'deposited', to: 'cleared', inputs: { origin: ctx.origin, date }, outcome: { gl: live, registerId } },
        tx,
      );
    });
  }

  /** The cheque did not clear: the receipt is reversed, every application is undone, invoices reopen. */
  async bounceCheque(
    ctx: FinanceContext,
    id: string,
    reason: { code: string; text?: string | null },
    opts: { postingDate?: string; permissions?: PostingPermissions } = {},
  ) {
    const rs = await this.reasons.require(ctx.companyId, reason, 'receipt');
    await this.db.transaction(async (tx) => {
      const r = await this.requireCheque(tx, ctx, id, ['received', 'deposited', 'cleared']);
      const from = r.chequeStatus;
      await this.reverseIn(tx, ctx, r, {
        reasonCode: rs.code,
        reasonText: rs.text,
        postingDate: opts.postingDate ?? businessDate(),
        perms: opts.permissions ?? NO_SPECIAL_PERMISSIONS,
        unapplyFirst: true,
        chequeStatus: 'bounced',
      });
      await this.event(tx, ctx, id, 'cheque_bounced', 'posted', 'reversed', { reasonCode: rs.code, reasonText: rs.text, data: { chequeWas: from } });
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'customer_receipt', id }, action: 'finance.cheque_bounced', actor: ctx.actor, from: 'posted', to: 'reversed', reason: rs, inputs: { origin: ctx.origin, chequeWas: from } },
        tx,
      );
    });
  }

  // ── evidence ─────────────────────────────────────────────────────────────

  async attach(ctx: FinanceContext, id: string, file: { mediaAssetId: string; fileName: string; note?: string | null }) {
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx, id);
      if (r.status === 'cancelled') throw new FinanceError('CANCELLED', 'That receipt was cancelled.');
      await tx.insert(financeAttachments).values({
        companyId: ctx.companyId,
        subjectType: 'customer_receipt',
        subjectId: id,
        mediaAssetId: file.mediaAssetId,
        fileName: file.fileName,
        note: file.note ?? null,
        uploadedBy: ctx.actor.id ?? 'system',
      });
      await this.event(tx, ctx, id, 'evidence_added', r.status, r.status, { data: { fileName: file.fileName } });
      await this.decisions.record(
        { companyId: ctx.companyId, subject: { type: 'customer_receipt', id }, action: 'finance.receipt_evidence_added', actor: ctx.actor, inputs: { origin: ctx.origin, fileName: file.fileName } },
        tx,
      );
    });
  }

  async attachments(companyId: string, id: string) {
    return await this.db
      .select()
      .from(financeAttachments)
      .where(and(eq(financeAttachments.companyId, companyId), eq(financeAttachments.subjectType, 'customer_receipt'), eq(financeAttachments.subjectId, id)))
      .orderBy(asc(financeAttachments.createdAt));
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async list(companyId: string, f: ReceiptListFilter = {}) {
    const limit = Math.min(f.limit ?? 50, 200);
    const q = f.q?.trim();
    const rows = await this.db
      .select({
        receipt: customerReceipts,
        customerName: customers.name,
        customerNumber: customers.number,
        methodName: paymentMethods.name,
        bankCode: bankAccounts.code,
      })
      .from(customerReceipts)
      .innerJoin(customers, eq(customers.id, customerReceipts.customerId))
      .innerJoin(paymentMethods, eq(paymentMethods.id, customerReceipts.paymentMethodId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, customerReceipts.bankAccountId))
      .where(
        and(
          eq(customerReceipts.companyId, companyId),
          has(f.status) ? eq(customerReceipts.status, f.status) : undefined,
          has(f.customerId) ? eq(customerReceipts.customerId, f.customerId) : undefined,
          has(f.before) ? lt(customerReceipts.createdAt, new Date(f.before)) : undefined,
          has(q)
            ? or(
                ilike(customerReceipts.number, `%${q}%`),
                ilike(customerReceipts.externalReference, `%${q}%`),
                ilike(customers.name, `%${q}%`),
                ilike(customers.number, `%${q}%`),
              )
            : undefined,
        ),
      )
      .orderBy(desc(customerReceipts.createdAt))
      .limit(limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return { rows: page, nextBefore: more ? page[page.length - 1].receipt.createdAt.toISOString() : null };
  }

  /** For the "who paid?" picker: a handful of matches, not a list of every customer. */
  async searchCustomers(companyId: string, q: string, limit = 15) {
    const term = q.trim();
    if (term.length < 2) return [];
    return await this.db
      .select({
        id: customers.id,
        number: customers.number,
        name: customers.name,
        phone: customers.phone,
        email: customers.email,
        accountType: customers.accountType,
        balance: customers.balance,
      })
      .from(customers)
      .where(
        and(
          eq(customers.companyId, companyId),
          eq(customers.isActive, true),
          or(
            ilike(customers.name, `%${term}%`),
            ilike(customers.number, `%${term}%`),
            ilike(customers.phone, `%${term}%`),
            ilike(customers.email, `%${term}%`),
          ),
        ),
      )
      .orderBy(asc(customers.name))
      .limit(limit);
  }

  async detail(companyId: string, id: string) {
    const [head] = await this.db
      .select({
        receipt: customerReceipts,
        customer: customers,
        method: paymentMethods,
        bank: bankAccounts,
      })
      .from(customerReceipts)
      .innerJoin(customers, eq(customers.id, customerReceipts.customerId))
      .innerJoin(paymentMethods, eq(paymentMethods.id, customerReceipts.paymentMethodId))
      .innerJoin(bankAccounts, eq(bankAccounts.id, customerReceipts.bankAccountId))
      .where(and(eq(customerReceipts.companyId, companyId), eq(customerReceipts.id, id)));
    if (!head) return null;
    const [events, attachments, applications, remaining] = await Promise.all([
      this.db.select().from(receiptEvents).where(eq(receiptEvents.receiptId, id)).orderBy(asc(receiptEvents.id)),
      this.attachments(companyId, id),
      has(head.receipt.ledgerEntryId)
        ? this.db.execute<{
            application_id: string; invoice_id: string; document_no: string; amount: string; at: string;
            undone: boolean; undone_by: string | null;
          }>(sql`
            SELECT d.application_id, d.applied_to_entry_id AS invoice_id, inv.document_no, d.amount,
                   d.created_at AS at,
                   EXISTS (SELECT 1 FROM customer_detailed_entries u WHERE u.unapplies_application_id = d.application_id) AS undone,
                   NULL::text AS undone_by
            FROM customer_detailed_entries d
            JOIN customer_ledger_entries inv ON inv.id = d.applied_to_entry_id
            WHERE d.ledger_entry_id = ${head.receipt.ledgerEntryId}::uuid AND d.entry_type = 'application'
            ORDER BY d.id`)
        : Promise.resolve([] as never[]),
      has(head.receipt.ledgerEntryId)
        ? this.db
            .select({ remaining: customerLedgerEntries.remainingAmount })
            .from(customerLedgerEntries)
            .where(eq(customerLedgerEntries.id, head.receipt.ledgerEntryId))
        : Promise.resolve([]),
    ]);
    const unappliedCents = remaining[0] ? -toCents(remaining[0].remaining) : 0;
    // People, not ids: who did each step.
    const actorIds = [...new Set([...events.map((e) => e.actorId), head.receipt.postedBy, head.receipt.createdBy])].filter(
      (x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x),
    );
    const named = actorIds.length !== 0
      ? await this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, actorIds))
      : [];
    const actors = Object.fromEntries(named.map((u) => [u.id, orElse(u.name, u.email)]));
    const depositId = head.receipt.counterparty.depositBankAccountId;
    const [deposit] = has(depositId)
      ? await this.db.select({ code: bankAccounts.code, name: bankAccounts.name }).from(bankAccounts).where(eq(bankAccounts.id, depositId))
      : [];
    return {
      ...head,
      actors,
      depositedInto: deposit ? `${deposit.code} — ${deposit.name}` : null,
      events,
      attachments,
      applications: [...applications],
      unappliedCents: head.receipt.status === 'posted' ? Math.max(unappliedCents, 0) : 0,
    };
  }
}
