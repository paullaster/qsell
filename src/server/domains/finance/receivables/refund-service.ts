import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  approvalEntries,
  approvalRequests,
  bankAccounts,
  bankLedgerEntries,
  creditNoteAccounting,
  creditNoteResolutions,
  creditNotes,
  customerReceipts,
  customerWallets,
  customers,
  financeAttachments,
  financeSettings,
  orders,
  paymentMethods,
  providerOperations,
  refundEvents,
  refundRequests,
  users,
  type RefundRequestRow,
  type RefundSource,
  type RefundStatus,
} from '@/server/db/drizzle/schema';
import { TransactionLedgerService } from '@/server/domains/transactions/ledger-service';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { fromCents, toCents } from '../domain/receivables';
import {
  availableToRefund,
  canMove,
  checkPayoutDetails,
  destinationChanged,
  looksDuplicate,
  refundedState,
} from '../domain/refund';
import type { PostingRequest } from '../domain/types';
import { NO_SPECIAL_PERMISSIONS, type PostingEngine, type PostingPermissions, type Tx } from '../engine';
import { FinanceError, type FinanceContext } from '../errors';
import type { PostingSetupService } from '../posting-setup-service';
import type { CreditPolicyService } from './credit-policy-service';
import type { CustomerLedgerService } from './customer-ledger-service';
import type { WalletService } from './wallet-service';

export interface RefundInput {
  customerId: string;
  sourceKind: RefundSource;
  sourceId: string;
  amount: string;
  paymentMethodId: string;
  payoutDetails: Record<string, string>;
  reasonCode: string;
  reasonText?: string | null;
  idempotencyKey?: string | null;
  /** Whether the person asking may send money somewhere other than the customer's own details. */
  mayChangeDestination?: boolean;
}

export interface Obligation {
  kind: RefundSource;
  id: string;
  label: string;
  currency: string;
  orderId: string | null;
  availableCents: number;
}

const ACTIVE_BEFORE_RESERVE: RefundStatus[] = ['draft', 'pending_approval'];

/**
 * Money paid back out to customers, end to end. A refund is made from something the business
 * owes (a credit note's excess, a wallet, a receipt that was overpaid), so it can never exceed it.
 * It is submitted, approved when a workflow says so, paid and recorded with evidence by a different
 * person from the one who approved it, and every step is kept: who, why, from where.
 */
export class RefundService {
  private readonly legacyLedger: TransactionLedgerService;

  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly engine: PostingEngine,
    private readonly ledger: CustomerLedgerService,
    private readonly wallets: WalletService,
    private readonly policies: CreditPolicyService,
    private readonly setup: PostingSetupService,
    private readonly numbering: NumberSeriesService,
    private readonly reasons: ReasonCodes,
  ) {
    this.legacyLedger = new TransactionLedgerService(db);
  }

  // ── helpers ──────────────────────────────────────────────────────────────

  private async event(tx: Tx, ctx: FinanceContext, refundId: string, event: string, from: string | null, to: string | null, extra: { reason?: { code?: string | null; text?: string | null }; data?: Record<string, unknown> } = {}) {
    await tx.insert(refundEvents).values({
      refundId,
      event,
      fromStatus: from,
      toStatus: to,
      reasonCode: extra.reason?.code ?? null,
      reasonText: extra.reason?.text ?? null,
      data: extra.data ?? {},
      actorType: ctx.actor.type,
      actorId: ctx.actor.id,
      origin: ctx.origin,
    });
  }

  private async lock(tx: Tx, companyId: string, id: string): Promise<RefundRequestRow> {
    const [r] = await tx.select().from(refundRequests).where(and(eq(refundRequests.companyId, companyId), eq(refundRequests.id, id))).for('update');
    if (!r) throw new FinanceError('NOT_FOUND', 'That refund does not exist.');
    return r;
  }

  private async move(tx: Tx, r: RefundRequestRow, to: RefundStatus, patch: Partial<typeof refundRequests.$inferInsert> = {}) {
    if (!canMove(r.status, to)) throw new FinanceError('BAD_STATE', `A refund that is ${r.status.replace('_', ' ')} cannot become ${to.replace('_', ' ')}.`);
    await tx.update(refundRequests).set({ status: to, updatedAt: new Date(), ...patch }).where(eq(refundRequests.id, r.id));
  }

  private async glLive(tx: Tx, companyId: string, date: string) {
    const [s] = await tx.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!s) throw new FinanceError('FINANCE_NOT_SET_UP', 'Finance has not been set up yet.');
    return { s, live: s.salesGlGoLive !== null && date >= s.salesGlGoLive };
  }

  /** What is owed from one source right now, before refunds still waiting are taken off. */
  private async openOf(tx: Pick<DrizzleDb, 'select'>, companyId: string, kind: RefundSource, sourceId: string, customerId: string): Promise<{ cents: number; currency: string; orderId: string | null; label: string } | null> {
    if (kind === 'credit_note_excess') {
      const [a] = await tx.select().from(creditNoteAccounting).where(and(eq(creditNoteAccounting.companyId, companyId), eq(creditNoteAccounting.creditNoteId, sourceId), eq(creditNoteAccounting.customerId, customerId)));
      if (!a) return null;
      const [cn] = await tx.select().from(creditNotes).where(eq(creditNotes.id, sourceId));
      const [res] = await tx.select({ n: sql<string>`COALESCE(SUM(${creditNoteResolutions.amount}), 0)` }).from(creditNoteResolutions).where(eq(creditNoteResolutions.creditNoteId, sourceId));
      return { cents: toCents(a.excess) - toCents(res?.n ?? '0'), currency: a.currency, orderId: cn?.sourceKind === 'order' ? cn.sourceId : null, label: `Credit note ${cn?.creditNoteNo ?? ''}` };
    }
    if (kind === 'wallet') {
      const [w] = await tx.select().from(customerWallets).where(and(eq(customerWallets.companyId, companyId), eq(customerWallets.id, sourceId), eq(customerWallets.customerId, customerId)));
      if (!w) return null;
      return { cents: toCents(w.balance), currency: w.currency, orderId: null, label: `Wallet (${w.currency})` };
    }
    const [r] = await tx.select().from(customerReceipts).where(and(eq(customerReceipts.companyId, companyId), eq(customerReceipts.id, sourceId), eq(customerReceipts.customerId, customerId)));
    if (!r || r.status !== 'posted' || !r.ledgerEntryId) return null;
    return { cents: await this.wallets.receiptUnappliedIn(tx, r.ledgerEntryId), currency: r.currency, orderId: r.orderId, label: `Receipt ${r.number}` };
  }

  private async committedIn(tx: Pick<DrizzleDb, 'select'>, kind: RefundSource, sourceId: string, exceptId?: string): Promise<number> {
    const rows = await tx.select({ id: refundRequests.id, a: refundRequests.amount }).from(refundRequests).where(and(eq(refundRequests.sourceKind, kind), eq(refundRequests.sourceId, sourceId), inArray(refundRequests.status, ACTIVE_BEFORE_RESERVE)));
    return rows.filter((r) => r.id !== exceptId).reduce((n, r) => n + toCents(r.a), 0);
  }

  // ── what can be refunded ─────────────────────────────────────────────────

  /** The things a customer is owed from, with how much of each can still be asked for. */
  async obligations(companyId: string, customerId: string): Promise<Obligation[]> {
    const out: Obligation[] = [];
    const cns = await this.db.select({ id: creditNoteAccounting.creditNoteId }).from(creditNoteAccounting).where(and(eq(creditNoteAccounting.companyId, companyId), eq(creditNoteAccounting.customerId, customerId), sql`${creditNoteAccounting.excess} > 0`));
    for (const c of cns) out.push(...(await this.one(companyId, customerId, 'credit_note_excess', c.id)));
    const wallets = await this.db.select({ id: customerWallets.id }).from(customerWallets).where(and(eq(customerWallets.companyId, companyId), eq(customerWallets.customerId, customerId), sql`${customerWallets.balance} > 0`));
    const policy = await this.policies.forCustomer(this.db, companyId, customerId);
    if (policy.walletCashOut) for (const w of wallets) out.push(...(await this.one(companyId, customerId, 'wallet', w.id)));
    const receipts = await this.db.select({ id: customerReceipts.id }).from(customerReceipts).where(and(eq(customerReceipts.companyId, companyId), eq(customerReceipts.customerId, customerId), eq(customerReceipts.status, 'posted')));
    for (const r of receipts) out.push(...(await this.one(companyId, customerId, 'receipt_unapplied', r.id)));
    return out.filter((o) => o.availableCents > 0);
  }

  private async one(companyId: string, customerId: string, kind: RefundSource, id: string): Promise<Obligation[]> {
    const open = await this.openOf(this.db, companyId, kind, id, customerId);
    if (!open) return [];
    const available = availableToRefund(open.cents, await this.committedIn(this.db, kind, id));
    return [{ kind, id, label: open.label, currency: open.currency, orderId: open.orderId, availableCents: available }];
  }

  // ── create ───────────────────────────────────────────────────────────────

  async create(ctx: FinanceContext, input: RefundInput): Promise<{ id: string; number: string; detailsChanged: boolean }> {
    const rs = await this.reasons.require(ctx.companyId, { code: input.reasonCode, text: input.reasonText }, 'refund');
    return this.db.transaction(async (tx) => {
      if (input.idempotencyKey) {
        const [dup] = await tx.select({ id: refundRequests.id, number: refundRequests.number, c: refundRequests.detailsChanged }).from(refundRequests).where(and(eq(refundRequests.companyId, ctx.companyId), eq(refundRequests.idempotencyKey, input.idempotencyKey)));
        if (dup) return { id: dup.id, number: dup.number, detailsChanged: dup.c };
      }
      const [customer] = await tx.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
      if (!customer) throw new FinanceError('CUSTOMER_NOT_FOUND', 'Choose the customer to refund.');
      if (customer.blocked === 'all') throw new FinanceError('CUSTOMER_BLOCKED', `${customer.name} is blocked, so nothing can be paid to them until that is lifted.`);
      const policy = await this.policies.forCustomer(tx, ctx.companyId, customer.id);
      if (!policy.refundsEnabled) throw new FinanceError('REFUNDS_OFF', 'This business does not pay refunds: what a customer is owed stays as credit (Finance → Wallet policy).');
      if (input.sourceKind === 'wallet' && !policy.walletCashOut) throw new FinanceError('CASH_OUT_OFF', `Taking the ${policy.label.toLowerCase()} out as money is not allowed (Finance → Wallet policy).`);

      let cents: number;
      try {
        cents = toCents(input.amount);
      } catch {
        throw new FinanceError('AMOUNT_INVALID', 'The amount must be a number with at most 2 decimal places.');
      }
      if (cents <= 0) throw new FinanceError('AMOUNT_INVALID', 'The amount must be more than zero.');
      const open = await this.openOf(tx, ctx.companyId, input.sourceKind, input.sourceId, customer.id);
      if (!open) throw new FinanceError('SOURCE_NOT_FOUND', 'What this refund is owed from was not found for this customer.');
      const available = availableToRefund(open.cents, await this.committedIn(tx, input.sourceKind, input.sourceId));
      if (cents > available) throw new FinanceError('OVER_OBLIGATION', `Only ${fromCents(available)} can still be refunded from ${open.label}.`);

      const [m] = await tx.select().from(paymentMethods).where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, input.paymentMethodId)));
      if (!m || !m.enabled) throw new FinanceError('METHOD_INVALID', 'Choose how the customer will be paid.');
      if (!m.usableFor.includes('customer_refund') || m.refundDestination === 'none') throw new FinanceError('METHOD_NOT_FOR_REFUNDS', `${m.name} cannot be used to pay refunds.`);
      if (m.refundDestination === 'automatic' && (m.kind !== 'mobile_money' || !m.providerId)) throw new FinanceError('METHOD_AUTOMATIC', `${m.name} pays out through its provider, which only works for mobile-money methods that go through M-Pesa; choose a method paid by hand.`);
      const details = Object.fromEntries(Object.entries(input.payoutDetails).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, v.trim()]));
      const bad = checkPayoutDetails(m.kind, details);
      if (bad) throw new FinanceError('PAYOUT_DETAILS', bad);
      const changed = destinationChanged(m.kind, details, customer.phone);
      if (changed && !input.mayChangeDestination) {
        throw new FinanceError('DESTINATION_CHANGED', 'That is not the phone number on this customer\'s record. Paying somewhere else needs the "change refund destination" permission.');
      }

      const dupe = looksDuplicate(
        (await tx.select().from(refundRequests).where(and(eq(refundRequests.customerId, customer.id), eq(refundRequests.companyId, ctx.companyId)))).map((r) => ({ customerId: r.customerId, amountCents: toCents(r.amount), methodId: r.paymentMethodId, status: r.status, createdAt: r.createdAt })),
        { customerId: customer.id, amountCents: cents, methodId: m.id },
        new Date(),
      );
      if (dupe) throw new FinanceError('DUPLICATE_REFUND', 'The same amount was already asked for this customer, by the same method, within the last day. Cancel that one first if this is a replacement.');

      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('refund', { companyId: ctx.companyId, branchId: undefined, date: businessDate(), document: { kind: 'refund', id }, actor: ctx.actor }, tx);
      await tx.insert(refundRequests).values({
        id,
        companyId: ctx.companyId,
        number,
        customerId: customer.id,
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        orderId: open.orderId,
        currency: open.currency,
        amount: fromCents(cents),
        reasonCode: rs.code,
        reasonText: rs.text,
        paymentMethodId: m.id,
        payoutDetails: details,
        detailsChanged: changed,
        requestedBy: ctx.actor.id ?? 'system',
        idempotencyKey: input.idempotencyKey ?? null,
      });
      await this.event(tx, ctx, id, 'created', null, 'draft', { reason: rs, data: { amount: fromCents(cents), source: open.label, method: m.code, detailsChanged: changed } });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund', id }, action: 'finance.refund_created', actor: ctx.actor, to: 'draft', reason: rs, inputs: { origin: ctx.origin, source: open.label }, outcome: { number, amount: fromCents(cents), method: m.code } }, tx);
      return { id, number, detailsChanged: changed };
    });
  }

  // ── submit and approve ───────────────────────────────────────────────────

  /** Sends a draft on: for approval when a workflow says so, otherwise straight to approved. */
  async submit(ctx: FinanceContext, id: string): Promise<{ status: RefundStatus }> {
    const { getContainer } = await import('@/server/di/container');
    return this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'draft') throw new FinanceError('NOT_DRAFT', `This refund is ${r.status.replace('_', ' ')}.`);
      const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, r.paymentMethodId));
      const [c] = await tx.select().from(customers).where(eq(customers.id, r.customerId));
      const outcome = await getContainer().approvals.submit(
        {
          companyId: ctx.companyId,
          trigger: 'refund.payout',
          documentId: r.id,
          branchId: r.branchId,
          requestedBy: ctx.actor.id ?? '',
          amount: Number(r.amount),
          snapshot: { reasonCode: r.reasonCode, methodKind: m?.kind ?? '', source: r.sourceKind, destinationChanged: r.detailsChanged, customer: { id: c?.id ?? '' } },
        },
        tx,
      );
      if (!outcome.required) {
        if (r.detailsChanged) {
          throw new FinanceError('CHANGED_DESTINATION_NEEDS_APPROVAL', 'This refund goes somewhere other than the customer\'s recorded details, so it must be approved, but no approval workflow covers refunds. Ask an administrator to set one up (Settings → Approvals).');
        }
        await this.event(tx, ctx, id, 'submitted', 'draft', 'approved', { data: { approval: 'not required' } });
        await this.approveIn(tx, ctx, r.id, null);
        return { status: 'approved' as RefundStatus };
      }
      if (outcome.released) {
        await this.event(tx, ctx, id, 'submitted', 'draft', 'approved', { data: { approval: 'released' } });
        await this.approveIn(tx, ctx, r.id, null);
        return { status: 'approved' as RefundStatus };
      }
      await this.move(tx, r, 'pending_approval');
      await this.event(tx, ctx, id, 'submitted', 'draft', 'pending_approval', { data: { requests: outcome.requests.length } });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund', id }, action: 'finance.refund_submitted', actor: ctx.actor, from: 'draft', to: 'pending_approval', inputs: { origin: ctx.origin } }, tx);
      return { status: 'pending_approval' as RefundStatus };
    });
  }

  /**
   * Approval given (by a person, or because nothing needed approving): the money is set aside.
   * The customer's credit leaves their account (or wallet) and becomes "refunds payable", so it
   * cannot be spent twice and the liability shows in the books until it is paid.
   */
  async approveIn(tx: Tx, ctx: FinanceContext, id: string, approvedBy: string | null): Promise<void> {
    const r = await this.lock(tx, ctx.companyId, id);
    if (r.status !== 'draft' && r.status !== 'pending_approval') return;
    const date = businessDate();
    const cents = toCents(r.amount);
    const open = await this.openOf(tx, ctx.companyId, r.sourceKind, r.sourceId, r.customerId);
    if (!open || open.cents < cents) {
      throw new FinanceError('OBLIGATION_GONE', `${open?.label ?? 'What this was owed from'} no longer has ${fromCents(cents)} to refund (${fromCents(Math.max(open?.cents ?? 0, 0))} left). Reject this request.`);
    }
    const policy = await this.policies.forCustomer(tx, ctx.companyId, r.customerId, date);
    const { s, live } = await this.glLive(tx, ctx.companyId, date);

    let ledgerEntryId: string | null = null;
    let walletEntryId: number | null = null;
    if (r.sourceKind === 'credit_note_excess') {
      const [a] = await tx.select().from(creditNoteAccounting).where(eq(creditNoteAccounting.creditNoteId, r.sourceId)).for('update');
      ledgerEntryId = a!.ledgerEntryId;
      await this.ledger.transferCreditIn(tx, ctx, a!.ledgerEntryId, cents, { postingDate: date, createdBy: ctx.actor.id, type: 'refund_transfer', reasonCode: r.reasonCode });
      await tx.insert(creditNoteResolutions).values({ companyId: ctx.companyId, creditNoteId: r.sourceId, kind: 'refund', amount: fromCents(cents), actorType: ctx.actor.type, actorId: ctx.actor.id, origin: ctx.origin, reasonCode: r.reasonCode });
    } else if (r.sourceKind === 'receipt_unapplied') {
      const [rc] = await tx.select().from(customerReceipts).where(eq(customerReceipts.id, r.sourceId)).for('update');
      ledgerEntryId = rc!.ledgerEntryId;
      await this.ledger.transferCreditIn(tx, ctx, rc!.ledgerEntryId!, cents, { postingDate: date, createdBy: ctx.actor.id, type: 'refund_transfer', reasonCode: r.reasonCode });
    } else {
      walletEntryId = await this.wallets.cashOutIn(tx, ctx, { customerId: r.customerId, currency: r.currency, cents, refundId: r.id, postingDate: date });
    }

    let registerId: string | null = null;
    if (live) {
      if (r.currency.toUpperCase() !== s.baseCurrency) throw new FinanceError('FOREIGN_CURRENCY', `Refunds in ${r.currency} are not posted to the general ledger yet.`);
      const [from, payable] = await Promise.all([
        this.setup.resolveCustomer(ctx.companyId, policy.groupCode, r.sourceKind === 'wallet' ? 'customer_deposits' : 'receivables'),
        this.setup.resolveCustomer(ctx.companyId, policy.groupCode, 'refunds_payable'),
      ]).catch((e: unknown) => {
        throw new FinanceError('POSTING_SETUP_MISSING', e instanceof Error ? e.message : 'Posting setup is incomplete.');
      });
      const req: PostingRequest = {
        companyId: ctx.companyId,
        idempotencyKey: `refund:${r.id}:reserve`,
        postingDate: date,
        documentType: 'refund_approved',
        documentNo: r.number,
        description: `Refund ${r.number} approved`,
        currency: s.baseCurrency,
        rate: '1',
        rateSource: 'base',
        lines: [
          { accountId: from.accountId, debit: fromCents(cents), credit: '0', description: `${open.label} set aside for refund ${r.number}`, sourceLedger: r.sourceKind === 'wallet' ? 'wallet' : 'customer', sourceEntryId: r.customerId },
          { accountId: payable.accountId, debit: '0', credit: fromCents(cents), description: `Refund ${r.number} to pay` },
        ],
        chainKey: r.branchId ?? 'general',
        branchId: r.branchId,
        origin: ctx.origin,
        source: { type: 'refund', id: r.id },
        postedBy: 'engine',
      };
      registerId = (await this.engine.post(req, { canPostSoftClosed: true, canPostControlAccounts: true }, tx)).registerId;
    }
    await this.move(tx, r, 'approved', { approvedBy, approvedAt: new Date(), ledgerEntryId, walletEntryId, reserveRegisterId: registerId });
    await this.event(tx, ctx, id, 'approved', r.status, 'approved', { data: { approvedBy: approvedBy ?? 'no approval needed', gl: live, registerId } });
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund', id }, action: 'finance.refund_approved', actor: ctx.actor, from: r.status, to: 'approved', inputs: { origin: ctx.origin, approvedBy }, outcome: { amount: fromCents(cents), gl: live } }, tx);
  }

  /** The approval workflow decided. These are called by it, in its transaction. */
  async onApproved(tx: Tx, id: string): Promise<void> {
    const [r] = await tx.select().from(refundRequests).where(eq(refundRequests.id, id));
    if (!r) return;
    const [last] = await tx
      .select({ by: approvalEntries.approverUserId })
      .from(approvalEntries)
      .innerJoin(approvalRequests, eq(approvalRequests.id, approvalEntries.requestId))
      .where(and(eq(approvalRequests.documentKind, 'refund'), eq(approvalRequests.documentId, id), eq(approvalEntries.status, 'approved')))
      .orderBy(desc(approvalEntries.actedAt))
      .limit(1);
    const ctx: FinanceContext = { companyId: r.companyId, actor: { type: 'user', id: last?.by ?? 'approvals' }, origin: { surface: 'approvals', action: 'release_refund', permissionUsed: null } };
    await this.approveIn(tx, ctx, id, last?.by ?? null);
  }

  async onRejected(tx: Tx, id: string, info: { reasonCode: string; comment: string }): Promise<void> {
    const [r] = await tx.select().from(refundRequests).where(eq(refundRequests.id, id)).for('update');
    if (!r || r.status !== 'pending_approval') return;
    const ctx: FinanceContext = { companyId: r.companyId, actor: { type: 'system', id: null }, origin: { surface: 'approvals', action: 'reject_refund' } };
    await this.move(tx, r, 'rejected');
    await this.event(tx, ctx, id, 'rejected', r.status, 'rejected', { reason: { code: info.reasonCode, text: info.comment } });
  }

  async onReopened(tx: Tx, id: string): Promise<void> {
    const [r] = await tx.select().from(refundRequests).where(eq(refundRequests.id, id)).for('update');
    if (!r || (r.status !== 'rejected' && r.status !== 'pending_approval')) return;
    const ctx: FinanceContext = { companyId: r.companyId, actor: { type: 'system', id: null }, origin: { surface: 'approvals', action: 'reopen_refund' } };
    if (r.status === 'rejected') await this.move(tx, r, 'draft');
    else await tx.update(refundRequests).set({ status: 'draft', updatedAt: new Date() }).where(eq(refundRequests.id, id));
    await this.event(tx, ctx, id, 'reopened', r.status, 'draft');
  }

  async onCanceled(tx: Tx, id: string): Promise<void> {
    const [r] = await tx.select().from(refundRequests).where(eq(refundRequests.id, id)).for('update');
    if (!r || r.status !== 'pending_approval') return;
    const ctx: FinanceContext = { companyId: r.companyId, actor: { type: 'system', id: null }, origin: { surface: 'approvals', action: 'withdraw_refund' } };
    await this.move(tx, r, 'cancelled');
    await this.event(tx, ctx, id, 'cancelled', r.status, 'cancelled', { data: { by: 'approval withdrawn' } });
  }

  // ── cancel ───────────────────────────────────────────────────────────────

  /** Stops a refund. If the money was already set aside it goes back where it came from. */
  async cancel(ctx: FinanceContext, id: string, reason: { code: string; text?: string | null }, perms: PostingPermissions = NO_SPECIAL_PERMISSIONS) {
    const rs = await this.reasons.require(ctx.companyId, reason, 'refund');
    const { getContainer } = await import('@/server/di/container');
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status === 'paid') throw new FinanceError('ALREADY_PAID', 'This refund has been paid. A payout cannot be cancelled; if the customer returns the money, record it as a receipt.');
      if (r.status === 'cancelled') throw new FinanceError('ALREADY_CANCELLED', 'This refund is already cancelled.');
      if (r.status === 'rejected') throw new FinanceError('NOT_ACTIVE', 'This refund was rejected.');
      const cents = toCents(r.amount);
      if (r.status === 'pending_approval') {
        const [req] = await tx.select({ sub: approvalRequests.submissionId }).from(approvalRequests).where(and(eq(approvalRequests.documentKind, 'refund'), eq(approvalRequests.documentId, id), eq(approvalRequests.status, 'pending'))).limit(1);
        if (req) await getContainer().approvals.cancel(req.sub, { userId: ctx.actor.id ?? '', isAdmin: true }, { text: rs.text ?? rs.code }, tx);
        const [fresh] = await tx.select().from(refundRequests).where(eq(refundRequests.id, id));
        if (fresh?.status !== 'cancelled') await this.move(tx, fresh!, 'cancelled');
      } else if (r.status === 'approved') {
        // Give back what was set aside.
        if (r.sourceKind === 'wallet') {
          await this.wallets.undoCashOutIn(tx, ctx, { customerId: r.customerId, currency: r.currency, cents, refundId: r.id, reason: rs });
        } else if (r.ledgerEntryId) {
          await this.ledger.transferCreditIn(tx, ctx, r.ledgerEntryId, -cents, { postingDate: businessDate(), createdBy: ctx.actor.id, type: 'refund_transfer', reasonCode: rs.code, reasonText: rs.text });
          if (r.sourceKind === 'credit_note_excess') {
            await tx.insert(creditNoteResolutions).values({ companyId: ctx.companyId, creditNoteId: r.sourceId, kind: 'refund_undone', amount: fromCents(-cents), actorType: ctx.actor.type, actorId: ctx.actor.id, origin: ctx.origin, reasonCode: rs.code, reasonText: rs.text });
          }
        }
        if (r.reserveRegisterId) {
          await this.engine.reverse({ companyId: ctx.companyId, registerId: r.reserveRegisterId, postingDate: businessDate(), reasonCode: rs.code, reasonText: rs.text, origin: ctx.origin, permissions: perms, tx });
        }
        await this.move(tx, r, 'cancelled');
      } else {
        await this.move(tx, r, 'cancelled');
      }
      await this.event(tx, ctx, id, 'cancelled', r.status, 'cancelled', { reason: rs });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund', id }, action: 'finance.refund_cancelled', actor: ctx.actor, from: r.status, to: 'cancelled', reason: rs, inputs: { origin: ctx.origin } }, tx);
    });
  }

  // ── pay ──────────────────────────────────────────────────────────────────

  async evidenceCount(db: Pick<DrizzleDb, 'select'>, id: string): Promise<number> {
    const [r] = await db.select({ n: sql<number>`count(*)::int` }).from(financeAttachments).where(and(eq(financeAttachments.subjectType, 'refund_request'), eq(financeAttachments.subjectId, id)));
    return r?.n ?? 0;
  }

  /**
   * Records that the money was paid out by hand. Needs the evidence (a payment slip, a bank
   * confirmation, an M-Pesa message, a signed receipt), a reference, and a person other than the
   * one who approved it.
   */
  async recordPayout(ctx: FinanceContext, id: string, input: { paidFromMethodId: string; payoutDate?: string; reference: string; permissions?: PostingPermissions; automatic?: { operationId: string } }) {
    const perms = input.permissions ?? NO_SPECIAL_PERMISSIONS;
    return this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'approved') throw new FinanceError('NOT_APPROVED', `Only an approved refund can be paid; this one is ${r.status.replace('_', ' ')}.`);
      if (!input.automatic) {
        const live = await this.payoutOperations(tx, id, ['pending_approval', 'queued', 'submitted', 'accepted', 'timed_out', 'in_doubt']);
        if (live.length > 0) throw new FinanceError('PAYOUT_IN_PROGRESS', 'This refund is being paid through M-Pesa and that has not finished or been checked yet; it cannot also be recorded as paid by hand until it is settled (see Payment activity).');
      }
      if (!input.automatic && r.approvedBy && r.approvedBy === ctx.actor.id) throw new FinanceError('SAME_PERSON', 'The person who approved a refund cannot be the one who records its payment.');
      const reference = input.reference.trim();
      if (!reference) throw new FinanceError('REFERENCE_REQUIRED', 'Enter the payment reference (M-Pesa code, bank reference, cheque number or receipt number).');
      if (!input.automatic && (await this.evidenceCount(tx, id)) === 0) throw new FinanceError('EVIDENCE_REQUIRED', 'Attach the evidence of payment first (a payment slip, bank confirmation, M-Pesa message or signed receipt).');
      const today = businessDate();
      const date = input.payoutDate ?? today;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date > today) throw new FinanceError('DATE_INVALID', 'The payout date cannot be in the future.');
      // The money leaves through a payment method: its bank account is where it came from, its G/L account is what the books credit.
      const [from] = await tx
        .select({ method: paymentMethods, bank: bankAccounts })
        .from(paymentMethods)
        .innerJoin(bankAccounts, eq(bankAccounts.id, paymentMethods.balancingBankAccountId))
        .where(and(eq(paymentMethods.companyId, ctx.companyId), eq(paymentMethods.id, input.paidFromMethodId)));
      const bank = from?.bank;
      const fromMethod = from?.method;
      if (!bank || !fromMethod || bank.blocked || !fromMethod.enabled) throw new FinanceError('BANK_INVALID', 'Choose the payment method the money was paid out through.');
      if (bank.kind === 'clearing') throw new FinanceError('BANK_INVALID', 'Money is paid from a bank, cash or mobile-money account, not a clearing account.');
      if (bank.currency !== r.currency) throw new FinanceError('CURRENCY_MISMATCH', `${bank.code} holds ${bank.currency}; this refund is in ${r.currency}.`);
      const issues = await this.engine.dateIssues(tx, ctx.companyId, date, perms);
      if (issues.length > 0) throw new FinanceError(issues[0]!.code, issues.map((i) => i.message).join(' '));
      const cents = toCents(r.amount);
      const { s, live } = await this.glLive(tx, ctx.companyId, date);
      const policy = await this.policies.forCustomer(tx, ctx.companyId, r.customerId, date);

      let registerId: string | null = null;
      if (live) {
        const payable = await this.setup.resolveCustomer(ctx.companyId, policy.groupCode, 'refunds_payable').catch((e: unknown) => {
          throw new FinanceError('POSTING_SETUP_MISSING', e instanceof Error ? e.message : 'Posting setup is incomplete.');
        });
        const req: PostingRequest = {
          companyId: ctx.companyId,
          idempotencyKey: `refund:${r.id}:pay`,
          postingDate: date,
          documentType: 'refund_paid',
          documentNo: r.number,
          description: `Refund ${r.number} paid (${reference})`,
          currency: s.baseCurrency,
          rate: '1',
          rateSource: 'base',
          lines: [
            { accountId: payable.accountId, debit: fromCents(cents), credit: '0', description: `Refund ${r.number} paid`, sourceLedger: 'customer', sourceEntryId: r.customerId },
            { accountId: fromMethod.glAccountId, debit: '0', credit: fromCents(cents), description: `Refund ${r.number} ${reference}`, sourceLedger: 'bank', sourceEntryId: bank.id },
          ],
          chainKey: r.branchId ?? 'general',
          branchId: r.branchId,
          origin: ctx.origin,
          source: { type: 'refund', id: r.id },
          postedBy: 'engine',
        };
        registerId = (await this.engine.post(req, perms, tx)).registerId;
      }
      await tx.insert(bankLedgerEntries).values({ companyId: ctx.companyId, bankAccountId: bank.id, glAccountId: fromMethod.glAccountId, postingDate: date, documentType: 'refund', documentNo: r.number, documentId: r.id, description: `Refund ${r.number} ${reference}`, amount: fromCents(-cents), currency: r.currency, registerId, createdBy: ctx.actor.id });
      await this.legacyLedger.post({ companyId: ctx.companyId, customerId: r.customerId, orderId: r.orderId, documentType: 'refund', documentNo: r.number, description: 'Refund paid', direction: 'debit', amount: cents / 100, currency: r.currency, transactionReference: reference, idempotencyKey: `refund:${r.id}` }, tx);
      await this.move(tx, r, 'paid', { paidFromBankAccountId: bank.id, paidFromMethodId: fromMethod.id, payoutReference: reference, payoutDate: date, paidBy: ctx.actor.id, paidAt: new Date(), payoutRegisterId: registerId });
      await this.event(tx, ctx, id, 'paid', 'approved', 'paid', { data: { bank: bank.code, reference, date, gl: live, registerId } });

      // "Refunded" only when the paid refunds against this order cover everything it was paid.
      let order: 'refunded' | 'partially_refunded' | 'none' = 'none';
      if (r.orderId) {
        const [o] = await tx.select().from(orders).where(eq(orders.id, r.orderId)).for('update');
        if (o && ['paid', 'reconciled', 'refunded', 'partially_refunded'].includes(o.paymentStatus)) {
          const [sum] = await tx.select({ n: sql<string>`COALESCE(SUM(${refundRequests.amount}), 0)` }).from(refundRequests).where(and(eq(refundRequests.orderId, r.orderId), eq(refundRequests.status, 'paid')));
          order = refundedState(toCents(o.totalAmount), toCents(sum?.n ?? '0'));
          if (order === 'refunded') await tx.update(orders).set({ paymentStatus: 'refunded', updatedAt: new Date() }).where(eq(orders.id, o.id));
          await this.event(tx, ctx, id, 'order_payment_state', null, null, { data: { order: o.orderNumber, state: order } });
        }
      }
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund', id }, action: 'finance.refund_paid', actor: ctx.actor, from: 'approved', to: 'paid', inputs: { origin: ctx.origin, reference, bank: bank.code }, outcome: { amount: fromCents(cents), gl: live, order } }, tx);
      return { number: r.number, order, gl: live };
    });
  }

  // ── automatic payout through the provider ───────────────────────────────

  private async payoutOperations(tx: Tx | DrizzleDb, refundId: string, statuses: string[]) {
    return tx.select({ id: providerOperations.id, status: providerOperations.status }).from(providerOperations).where(and(eq(providerOperations.subjectType, 'refund'), eq(providerOperations.subjectId, refundId), inArray(providerOperations.status, statuses as never)));
  }

  /**
   * Checks an approved refund may be paid through M-Pesa and tells what to send. The approval it already
   * has is the approval for the money; the person who sends it must not be the one who approved it.
   */
  async prepareAutomatic(ctx: FinanceContext, id: string) {
    return this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status !== 'approved') throw new FinanceError('NOT_APPROVED', `Only an approved refund can be paid; this one is ${r.status.replace('_', ' ')}.`);
      if (r.approvedBy && r.approvedBy === ctx.actor.id) throw new FinanceError('SAME_PERSON', 'The person who approved a refund cannot be the one who sends its payment.');
      const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, r.paymentMethodId));
      if (!m || m.refundDestination !== 'automatic' || m.kind !== 'mobile_money' || !m.providerId) throw new FinanceError('NOT_AUTOMATIC', 'This refund\'s payment method is not set to pay out through M-Pesa.');
      if (!/^\d+$/.test(r.amount.split('.')[0]!) || Number(r.amount) % 1 !== 0) throw new FinanceError('AMOUNT_NOT_WHOLE', 'M-Pesa pays whole shillings only; pay this refund by hand.');
      const phone = (r.payoutDetails as Record<string, string>).phone;
      if (!phone) throw new FinanceError('PAYOUT_DETAILS', 'The refund has no phone number to pay.');
      const live = await this.payoutOperations(tx, id, ['queued', 'submitted', 'accepted', 'timed_out', 'in_doubt', 'succeeded']);
      if (live.length > 0) throw new FinanceError('PAYOUT_IN_PROGRESS', 'A payment for this refund has already been sent or is waiting for a check. See Payment activity.');
      await this.event(tx, ctx, id, 'auto_payout_requested', 'approved', 'approved', { data: { methodId: m.id, amount: r.amount } });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund', id }, action: 'finance.refund_auto_payout_requested', actor: ctx.actor, inputs: { origin: ctx.origin } }, tx);
      const attempt = (await tx.select({ n: sql<string>`count(*)` }).from(providerOperations).where(and(eq(providerOperations.subjectType, 'refund'), eq(providerOperations.subjectId, id))))[0]?.n ?? '0';
      return { providerId: m.providerId, methodId: m.id, phone, amount: r.amount, number: r.number, attempt: Number(attempt) + 1 };
    });
  }

  /** The payout through M-Pesa finished (told by the payment engine): record it, or say why not. */
  async onAutomaticPayoutFinished(op: { id: string; companyId: string; subjectId: string | null; status: string; platformReference: string | null; failureCode: string | null; failureReason: string | null }): Promise<void> {
    if (!op.subjectId) return;
    const ctx: FinanceContext = { companyId: op.companyId, actor: { type: 'system', id: null }, origin: { surface: 'payments/engine', action: 'refund_auto_payout' } };
    const [r] = await this.db.select().from(refundRequests).where(eq(refundRequests.id, op.subjectId));
    if (!r || r.status !== 'approved') return;
    if (op.status === 'succeeded' && op.platformReference) {
      try {
        await this.recordPayout(ctx, r.id, { paidFromMethodId: r.paymentMethodId, reference: op.platformReference, automatic: { operationId: op.id } });
      } catch (error) {
        // The money is out. Say so, loudly, so a person records it by hand with this reference.
        await this.db.transaction(async (tx) => {
          await this.event(tx, ctx, r.id, 'auto_payout_paid_not_recorded', 'approved', 'approved', { data: { operation: op.id, reference: op.platformReference, reason: error instanceof Error ? error.message : 'unknown' } });
        });
      }
      return;
    }
    await this.db.transaction(async (tx) => {
      await this.event(tx, ctx, r.id, 'auto_payout_not_paid', 'approved', 'approved', { data: { operation: op.id, status: op.status, code: op.failureCode, reason: op.failureReason } });
    });
  }

  // ── evidence ─────────────────────────────────────────────────────────────

  async attach(ctx: FinanceContext, id: string, file: { mediaAssetId: string; fileName: string; note?: string | null }) {
    await this.db.transaction(async (tx) => {
      const r = await this.lock(tx, ctx.companyId, id);
      if (r.status === 'cancelled' || r.status === 'rejected') throw new FinanceError('NOT_ACTIVE', `This refund is ${r.status}.`);
      await tx.insert(financeAttachments).values({ companyId: ctx.companyId, subjectType: 'refund_request', subjectId: id, mediaAssetId: file.mediaAssetId, fileName: file.fileName, note: file.note ?? null, uploadedBy: ctx.actor.id ?? 'system' });
      await this.event(tx, ctx, id, 'evidence_added', r.status, r.status, { data: { fileName: file.fileName } });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'refund', id }, action: 'finance.refund_evidence_added', actor: ctx.actor, inputs: { origin: ctx.origin, fileName: file.fileName } }, tx);
    });
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async customerName(companyId: string, id: string) {
    const [c] = await this.db.select({ n: customers.name }).from(customers).where(and(eq(customers.companyId, companyId), eq(customers.id, id)));
    return c?.n ?? null;
  }

  async list(companyId: string, f: { status?: RefundStatus; q?: string; customerId?: string; before?: string; limit?: number } = {}) {
    const limit = Math.min(f.limit ?? 50, 200);
    const q = f.q?.trim();
    const rows = await this.db
      .select({ r: refundRequests, customerName: customers.name, customerNumber: customers.number, methodName: paymentMethods.name })
      .from(refundRequests)
      .innerJoin(customers, eq(customers.id, refundRequests.customerId))
      .innerJoin(paymentMethods, eq(paymentMethods.id, refundRequests.paymentMethodId))
      .where(and(eq(refundRequests.companyId, companyId), f.status ? eq(refundRequests.status, f.status) : undefined, f.customerId ? eq(refundRequests.customerId, f.customerId) : undefined, f.before ? lt(refundRequests.createdAt, new Date(f.before)) : undefined, q ? or(ilike(refundRequests.number, `%${q}%`), ilike(customers.name, `%${q}%`), ilike(customers.number, `%${q}%`), ilike(refundRequests.payoutReference, `%${q}%`)) : undefined))
      .orderBy(desc(refundRequests.createdAt))
      .limit(limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return { rows: page, nextBefore: more ? page[page.length - 1]!.r.createdAt.toISOString() : null };
  }

  async detail(companyId: string, id: string) {
    const [head] = await this.db
      .select({ r: refundRequests, customer: customers, method: paymentMethods })
      .from(refundRequests)
      .innerJoin(customers, eq(customers.id, refundRequests.customerId))
      .innerJoin(paymentMethods, eq(paymentMethods.id, refundRequests.paymentMethodId))
      .where(and(eq(refundRequests.companyId, companyId), eq(refundRequests.id, id)));
    if (!head) return null;
    const [events, attachments, source] = await Promise.all([
      this.db.select().from(refundEvents).where(eq(refundEvents.refundId, id)).orderBy(asc(refundEvents.id)),
      this.db.select().from(financeAttachments).where(and(eq(financeAttachments.companyId, companyId), eq(financeAttachments.subjectType, 'refund_request'), eq(financeAttachments.subjectId, id))).orderBy(asc(financeAttachments.createdAt)),
      this.openOf(this.db, companyId, head.r.sourceKind, head.r.sourceId, head.r.customerId),
    ]);
    const ids = [...new Set([...events.map((e) => e.actorId), head.r.requestedBy, head.r.approvedBy, head.r.paidBy])].filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x));
    const named = ids.length ? await this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)) : [];
    return { ...head, events, attachments, sourceLabel: source?.label ?? '', actors: Object.fromEntries(named.map((u) => [u.id, u.name || u.email])) };
  }

  /** For the owner: what was asked, paid and is stuck, over a period. */
  async report(companyId: string, from: string, to: string, stuckDays = 3) {
    const [byStatus, byReason, byMethod, stuck] = await Promise.all([
      this.db.execute<{ status: string; n: number; total: string }>(sql`SELECT status, count(*)::int n, COALESCE(SUM(amount),0)::text total FROM refund_requests WHERE company_id = ${companyId}::uuid AND created_at >= ${from}::date AND created_at < (${to}::date + 1) GROUP BY status`),
      this.db.execute<{ reason: string; n: number; total: string }>(sql`SELECT reason_code AS reason, count(*)::int n, COALESCE(SUM(amount),0)::text total FROM refund_requests WHERE company_id = ${companyId}::uuid AND status = 'paid' AND paid_at >= ${from}::date AND paid_at < (${to}::date + 1) GROUP BY reason_code ORDER BY SUM(amount) DESC`),
      this.db.execute<{ method: string; n: number; total: string }>(sql`SELECT m.name AS method, count(*)::int n, COALESCE(SUM(r.amount),0)::text total FROM refund_requests r JOIN payment_methods m ON m.id = r.payment_method_id WHERE r.company_id = ${companyId}::uuid AND r.status = 'paid' AND r.paid_at >= ${from}::date AND r.paid_at < (${to}::date + 1) GROUP BY m.name ORDER BY SUM(r.amount) DESC`),
      this.db
        .select({ r: refundRequests, customerName: customers.name })
        .from(refundRequests)
        .innerJoin(customers, eq(customers.id, refundRequests.customerId))
        .where(and(eq(refundRequests.companyId, companyId), eq(refundRequests.status, 'approved'), sql`${refundRequests.approvedAt} < now() - make_interval(days => ${stuckDays})`))
        .orderBy(asc(refundRequests.approvedAt))
        .limit(50),
    ]);
    return { byStatus: [...byStatus], byReason: [...byReason], byMethod: [...byMethod], stuck };
  }

  /** Refunds payable in the books against refunds that have been approved and not yet paid, per account. */
  async payableReconciliation(companyId: string) {
    const [st] = await this.db.select().from(financeSettings).where(eq(financeSettings.companyId, companyId));
    if (!st) return [];
    const rows = await this.db.execute<{ account_id: string; no: string; name: string; owed: string }>(sql`
      SELECT g.refunds_payable_account_id AS account_id, a.no, a.name,
             COALESCE(SUM(r.amount) FILTER (WHERE r.status = 'approved' AND r.currency = ${st.baseCurrency}), 0)::text AS owed
      FROM customer_posting_groups g
      JOIN gl_accounts a ON a.id = g.refunds_payable_account_id
      LEFT JOIN customers c ON COALESCE(c.posting_group_code, ${st.defaultCustomerGroup}) = g.code AND c.company_id = g.company_id
      LEFT JOIN refund_requests r ON r.customer_id = c.id
      WHERE g.company_id = ${companyId}::uuid
      GROUP BY g.refunds_payable_account_id, a.no, a.name`);
    const out = [];
    for (const r of rows) {
      const [bal] = await this.db.execute<{ net: string }>(sql`SELECT COALESCE(SUM(base_credit - base_debit), 0)::text AS net FROM gl_account_balances WHERE company_id = ${companyId}::uuid AND account_id = ${r.account_id}::uuid`);
      const gl = toCents(Number(bal?.net ?? 0).toFixed(2));
      const owed = toCents(r.owed);
      out.push({ accountNo: r.no, accountName: r.name, glCents: gl, owedCents: owed, diffCents: gl - owed });
    }
    return out;
  }
}
