import { and, asc, desc, eq, ilike, inArray, lt, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  approvalRequests,
  creditAdjustmentEvents,
  creditAdjustments,
  creditNoteAccounting,
  customerCreditPolicies,
  creditNoteResolutions,
  customerLedgerEntries,
  customerReceipts,
  customerWallets,
  customers,
  users,
  type CreditAdjustmentKind,
  type CreditAdjustmentRow,
  type CreditAdjustmentStatus,
  type RefundSource,
} from '@/server/db/drizzle/schema';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import type { ReasonCodes } from '@/server/kernel/reason-codes/service';
import { fromCents, toCents } from '../domain/receivables';
import { adjustmentCapabilities, canDecide, checkAdjustmentAmount, nextStatuses } from '../domain/credit-adjustment';
import { expiryState } from '../domain/wallet';
import type { PostingRequest } from '../domain/types';
import type { PostingEngine, Tx } from '../engine';
import { FinanceError, type FinanceContext } from '../errors';
import type { PostingSetupService } from '../posting-setup-service';
import type { CreditPolicyService } from './credit-policy-service';
import type { CustomerLedgerService } from './customer-ledger-service';
import type { FxService } from '../fx-service';
import type { RefundService } from './refund-service';
import type { WalletService } from './wallet-service';

import { has, orElse, required } from '@/lib/values';

export interface AdjustmentInput {
  kind: Exclude<CreditAdjustmentKind, 'wallet_expiry'>;
  customerId: string;
  /** For giving up an excess: what is owed from (a credit note's excess or an unapplied receipt). */
  sourceKind?: RefundSource;
  sourceId?: string;
  /** For the wallet kinds; the books' currency when left out. */
  currency?: string;
  amount: string;
  reasonCode: string;
  reasonText?: string | null;
  idempotencyKey?: string | null;
}

const SYSTEM = { canPostSoftClosed: true, canPostControlAccounts: true };

/**
 * Changing what a customer is owed without paying them: giving up an excess nobody will claim, adding to a wallet as goodwill
 * or a correction, taking from it, and the lapse of a balance that sat unused. One person asks, another decides (through an
 * approval workflow when one covers it), and every step is kept: who, why, from where.
 */
export class CreditAdjustmentService {
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
    private readonly refunds: RefundService,
    private readonly fx: FxService,
  ) {}

  // ── helpers ──────────────────────────────────────────────────────────────

  private async event(tx: Tx, ctx: FinanceContext, id: string, event: string, from: string | null, to: string | null, extra: { reason?: { code?: string | null; text?: string | null }; data?: Record<string, unknown> } = {}) {
    await tx.insert(creditAdjustmentEvents).values({
      adjustmentId: id,
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

  private async lock(tx: Tx, companyId: string, id: string): Promise<CreditAdjustmentRow> {
    const [a] = await tx.select().from(creditAdjustments).where(and(eq(creditAdjustments.companyId, companyId), eq(creditAdjustments.id, id))).for('update');
    if (!a) throw new FinanceError('NOT_FOUND', 'That credit adjustment does not exist.');
    return a;
  }

  private async move(tx: Tx, a: CreditAdjustmentRow, to: CreditAdjustmentStatus, patch: Partial<typeof creditAdjustments.$inferInsert> = {}) {
    if (!nextStatuses(a.status).includes(to)) throw new FinanceError('BAD_STATE', `A credit adjustment that is ${a.status.replace('_', ' ')} cannot become ${to.replace('_', ' ')}.`);
    await tx.update(creditAdjustments).set({ status: to, updatedAt: new Date(), ...patch }).where(eq(creditAdjustments.id, a.id));
  }

  /** What is left to give up on a source, counting everything already spoken for. */
  private async availableOn(tx: Tx | DrizzleDb, companyId: string, kind: RefundSource, sourceId: string, customerId: string, exceptId?: string) {
    const open = await this.refunds.openOf(tx, companyId, kind, sourceId, customerId);
    if (!open) return null;
    return { open, availableCents: Math.max(0, open.cents - (await this.refunds.committedIn(tx, kind, sourceId, exceptId))) };
  }

  // ── ask ──────────────────────────────────────────────────────────────────

  async request(ctx: FinanceContext, input: AdjustmentInput): Promise<{ id: string; number: string }> {
    const rs = await this.reasons.require(ctx.companyId, { code: input.reasonCode, text: input.reasonText }, input.kind === 'waive_excess' ? 'refund' : 'wallet');
    let cents: number;
    try {
      cents = toCents(input.amount);
    } catch {
      throw new FinanceError('AMOUNT_INVALID', 'The amount must be a number with at most 2 decimal places.');
    }
    const amountProblem = checkAdjustmentAmount(cents);
    if (amountProblem !== null) throw new FinanceError('AMOUNT_INVALID', amountProblem);
    return await this.db.transaction(async (tx) => {
      if (has(input.idempotencyKey)) {
        const [dup] = await tx.select({ id: creditAdjustments.id, number: creditAdjustments.number }).from(creditAdjustments).where(and(eq(creditAdjustments.companyId, ctx.companyId), eq(creditAdjustments.idempotencyKey, input.idempotencyKey)));
        if (dup) return dup;
      }
      const [customer] = await tx.select().from(customers).where(and(eq(customers.companyId, ctx.companyId), eq(customers.id, input.customerId)));
      if (!customer) throw new FinanceError('CUSTOMER_NOT_FOUND', 'Choose the customer.');
      const { s } = await this.refunds.glLive(tx, ctx.companyId, businessDate());
      let currency = orElse(input.currency, s.baseCurrency).toUpperCase();
      let sourceKind: RefundSource | null = null;
      let sourceId: string | null = null;

      if (input.kind === 'waive_excess') {
        if (input.sourceKind !== 'credit_note_excess' && input.sourceKind !== 'receipt_unapplied') throw new FinanceError('SOURCE_INVALID', 'Only an excess on a credit note or an unapplied receipt can be given up.');
        if (!has(input.sourceId)) throw new FinanceError('SOURCE_INVALID', 'Choose what is being given up.');
        const found = await this.availableOn(tx, ctx.companyId, input.sourceKind, input.sourceId, customer.id);
        if (!found) throw new FinanceError('SOURCE_NOT_FOUND', 'What this is owed from was not found for this customer.');
        if (cents > found.availableCents) throw new FinanceError('OVER_OBLIGATION', `Only ${fromCents(found.availableCents)} can still be given up from ${found.open.label}.`);
        currency = found.open.currency;
        sourceKind = input.sourceKind;
        sourceId = input.sourceId;
      } else {
        const policy = await this.policies.forCustomer(tx, ctx.companyId, customer.id);
        if (!policy.walletEnabled) throw new FinanceError('WALLET_OFF', `The ${policy.label.toLowerCase()} is not switched on for this customer.`);
        const [w] = await tx.select().from(customerWallets).where(and(eq(customerWallets.customerId, customer.id), eq(customerWallets.currency, currency)));
        if (input.kind === 'wallet_decrease') {
          if (!w) throw new FinanceError('WALLET_INSUFFICIENT', `This customer has no ${policy.label.toLowerCase()} in ${currency}.`);
          const waiting = await this.committedIn(tx, w.id);
          if (cents > toCents(w.balance) - waiting) throw new FinanceError('WALLET_INSUFFICIENT', `Only ${fromCents(Math.max(0, toCents(w.balance) - waiting))} of the ${policy.label.toLowerCase()} is free to take off.`);
        }
        if (w) {
          sourceKind = 'wallet';
          sourceId = w.id;
        }
      }

      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('credit_adjustment', { companyId: ctx.companyId, branchId: undefined, date: businessDate(), document: { kind: 'credit_adjustment', id }, actor: ctx.actor }, tx);
      await tx.insert(creditAdjustments).values({
        id,
        companyId: ctx.companyId,
        number,
        kind: input.kind,
        customerId: customer.id,
        sourceKind,
        sourceId,
        currency,
        amount: fromCents(cents),
        reasonCode: rs.code,
        reasonText: rs.text,
        requestedBy: ctx.actor.id ?? 'system',
        idempotencyKey: input.idempotencyKey ?? null,
      });
      await this.event(tx, ctx, id, 'requested', null, 'requested', { reason: rs, data: { kind: input.kind, amount: fromCents(cents), currency } });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'credit_adjustment', id }, action: 'finance.credit_adjustment_requested', actor: ctx.actor, to: 'requested', reason: rs, inputs: { origin: ctx.origin, kind: input.kind }, outcome: { number, amount: fromCents(cents) } }, tx);
      return { id, number };
    });
  }

  /** Wallet money already asked to be taken off and not yet decided. */
  private async committedIn(tx: Tx | DrizzleDb, walletId: string): Promise<number> {
    const rows = await tx.select({ a: creditAdjustments.amount }).from(creditAdjustments).where(and(eq(creditAdjustments.sourceKind, 'wallet'), eq(creditAdjustments.sourceId, walletId), eq(creditAdjustments.kind, 'wallet_decrease'), inArray(creditAdjustments.status, ['requested', 'pending_approval'])));
    return rows.reduce((n, r) => n + toCents(r.a), 0);
  }

  // ── decide ───────────────────────────────────────────────────────────────

  /** Sends the request for approval when a workflow covers it; otherwise it waits for a person other than the requester. */
  async submit(ctx: FinanceContext, id: string): Promise<{ status: CreditAdjustmentStatus }> {
    const { getContainer } = await import('@/server/di/container');
    return await this.db.transaction(async (tx) => {
      const a = await this.lock(tx, ctx.companyId, id);
      if (a.status !== 'requested') throw new FinanceError('BAD_STATE', `This credit adjustment is ${a.status.replace('_', ' ')}.`);
      const outcome = await getContainer().approvals.submit(
        {
          companyId: ctx.companyId,
          trigger: 'credit_adjustment.requested',
          documentId: a.id,
          branchId: null,
          requestedBy: ctx.actor.id ?? '',
          amount: Number(a.amount),
          snapshot: { kind: a.kind, reasonCode: a.reasonCode, customer: { id: a.customerId } },
        },
        tx,
      );
      if (!outcome.required) return { status: 'requested' as CreditAdjustmentStatus };
      if (outcome.released) {
        await this.event(tx, ctx, id, 'released', 'requested', 'requested', { data: { approval: 'released' } });
        await this.applyIn(tx, ctx, a.id, null);
        return { status: 'applied' as CreditAdjustmentStatus };
      }
      await this.move(tx, a, 'pending_approval');
      await this.event(tx, ctx, id, 'submitted', 'requested', 'pending_approval', { data: { requests: outcome.requests.length } });
      return { status: 'pending_approval' as CreditAdjustmentStatus };
    });
  }

  /** The decision of a person when no workflow covers the request. Never the person who asked. */
  async decide(ctx: FinanceContext, id: string, decision: 'approve' | 'reject', note?: string | null): Promise<{ status: CreditAdjustmentStatus }> {
    return await this.db.transaction(async (tx) => {
      const a = await this.lock(tx, ctx.companyId, id);
      if (a.status !== 'requested') throw new FinanceError('BAD_STATE', `Only a request waiting for a decision can be decided; this one is ${a.status.replace('_', ' ')}.`);
      const verdict = canDecide({ requestedBy: a.requestedBy, decidedBy: ctx.actor.id });
      if (verdict !== null) throw new FinanceError('SAME_PERSON', verdict);
      if (decision === 'reject') {
        if (!has(note) || note.trim().length < 3) throw new FinanceError('NOTE_REQUIRED', 'Say why you are turning it down.');
        await this.move(tx, a, 'rejected', { decidedBy: ctx.actor.id, decidedAt: new Date() });
        await this.event(tx, ctx, id, 'rejected', a.status, 'rejected', { reason: { text: note.trim() } });
        await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'credit_adjustment', id }, action: 'finance.credit_adjustment_rejected', actor: ctx.actor, from: a.status, to: 'rejected', reason: { text: note.trim() }, inputs: { origin: ctx.origin } }, tx);
        return { status: 'rejected' as CreditAdjustmentStatus };
      }
      await this.applyIn(tx, ctx, id, ctx.actor.id);
      return { status: 'applied' as CreditAdjustmentStatus };
    });
  }

  /**
   * The request is approved (by a person, or by the workflow): it takes effect. The customer's credit or wallet changes and,
   * once sales are live, the books post it. Everything in the caller's transaction, so it all happens or none of it does.
   */
  async applyIn(tx: Tx, ctx: FinanceContext, id: string, decidedBy: string | null): Promise<void> {
    const a = await this.lock(tx, ctx.companyId, id);
    if (a.status !== 'requested' && a.status !== 'pending_approval') return;
    const date = businessDate();
    const cents = toCents(a.amount);
    const { s, live } = await this.refunds.glLive(tx, ctx.companyId, date);
    const policy = await this.policies.forCustomer(tx, ctx.companyId, a.customerId, date);
    const reason = { code: a.reasonCode, text: a.reasonText };
    let ledgerEntryId: string | null = null;
    let walletEntryId: number | null = null;
    let wallet = false;
    // In another currency the books are posted at the rate what is being adjusted is carried at: a receipt's own, a wallet's average.
    let rate = '1';

    if (a.kind === 'waive_excess') {
      const kind = required(a.sourceKind, 'the source');
      const sourceId = required(a.sourceId, 'the source');
      const found = await this.availableOn(tx, ctx.companyId, kind, sourceId, a.customerId, a.id);
      if (!found || found.open.cents < cents) throw new FinanceError('OBLIGATION_GONE', `${found?.open.label ?? 'What this was owed from'} no longer has ${fromCents(cents)} to give up (${fromCents(Math.max(found?.open.cents ?? 0, 0))} left). Reject this request.`);
      if (kind === 'credit_note_excess') {
        const [acc] = await tx.select().from(creditNoteAccounting).where(eq(creditNoteAccounting.creditNoteId, sourceId)).for('update');
        ledgerEntryId = acc.ledgerEntryId;
        await this.ledger.transferCreditIn(tx, ctx, acc.ledgerEntryId, cents, { postingDate: date, createdBy: ctx.actor.id, type: 'write_off', reasonCode: a.reasonCode, reasonText: a.reasonText });
        await tx.insert(creditNoteResolutions).values({ companyId: ctx.companyId, creditNoteId: sourceId, kind: 'waived', amount: fromCents(cents), actorType: ctx.actor.type, actorId: ctx.actor.id, origin: ctx.origin, reasonCode: a.reasonCode, reasonText: a.reasonText });
      } else {
        const [rc] = await tx.select().from(customerReceipts).where(eq(customerReceipts.id, sourceId)).for('update');
        ledgerEntryId = rc.ledgerEntryId;
        await this.ledger.transferCreditIn(tx, ctx, required(rc.ledgerEntryId, 'the receipt\'s ledger entry'), cents, { postingDate: date, createdBy: ctx.actor.id, type: 'write_off', reasonCode: a.reasonCode, reasonText: a.reasonText });
      }
      if (a.currency.toUpperCase() !== s.baseCurrency) {
        const [entry] = await tx.select({ id: customerLedgerEntries.id, currency: customerLedgerEntries.currency, postingDate: customerLedgerEntries.postingDate }).from(customerLedgerEntries).where(eq(customerLedgerEntries.id, required(ledgerEntryId, 'the ledger entry')));
        rate = (await this.fx.carryingRates(tx, ctx.companyId, [{ id: entry.id, currency: orElse(entry.currency, a.currency), postingDate: orElse(entry.postingDate, date) }])).get(entry.id) ?? '1';
      }
    } else {
      wallet = true;
      const signed = a.kind === 'wallet_increase' ? cents : -cents;
      const out = await this.wallets.adjustIn(tx, ctx, { customerId: a.customerId, currency: a.currency, cents: signed, type: a.kind === 'wallet_expiry' ? 'expiry' : 'adjustment', sourceId: a.id, postingDate: date, reason });
      walletEntryId = out.entryId;
      rate = out.rate;
    }

    let registerId: string | null = null;
    if (live) {
      const foreign = a.currency.toUpperCase() !== s.baseCurrency;
      const { credit, debit } = await this.accountsFor(ctx.companyId, policy.groupCode, a.kind).catch((e: unknown) => {
        throw new FinanceError('POSTING_SETUP_MISSING', e instanceof Error ? e.message : 'Posting setup is incomplete.');
      });
      const req: PostingRequest = {
        companyId: ctx.companyId,
        idempotencyKey: `credit_adjustment:${a.id}:apply`,
        postingDate: date,
        documentType: 'credit_adjustment',
        documentNo: a.number,
        description: `Credit adjustment ${a.number}`,
        currency: foreign ? a.currency.toUpperCase() : s.baseCurrency,
        rate: foreign ? rate : '1',
        rateSource: foreign ? 'manual' : 'base',
        lines: [
          { accountId: debit.accountId, debit: fromCents(cents), credit: '0', description: `${debit.label} (${a.number})`, ...(debit.ledger === undefined ? {} : { sourceLedger: debit.ledger, sourceEntryId: a.customerId }) },
          { accountId: credit.accountId, debit: '0', credit: fromCents(cents), description: `${credit.label} (${a.number})`, ...(credit.ledger === undefined ? {} : { sourceLedger: credit.ledger, sourceEntryId: a.customerId }) },
        ],
        chainKey: 'general',
        origin: ctx.origin,
        source: { type: 'credit_adjustment', id: a.id },
        postedBy: 'engine',
      };
      registerId = (await this.engine.post(req, SYSTEM, tx)).registerId;
    }
    await this.move(tx, a, 'applied', { decidedBy, decidedAt: new Date(), registerId, ledgerEntryId, walletEntryId });
    await this.event(tx, ctx, id, 'applied', a.status, 'applied', { data: { decidedBy: decidedBy ?? 'workflow', gl: live, registerId, wallet } });
    await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'credit_adjustment', id }, action: 'finance.credit_adjustment_applied', actor: ctx.actor, from: a.status, to: 'applied', reason, inputs: { origin: ctx.origin, decidedBy }, outcome: { amount: fromCents(cents), kind: a.kind, gl: live } }, tx);
  }

  /** The debit and credit side of the books for each kind: what is given up, and where the other side goes. */
  private async accountsFor(companyId: string, group: string, kind: CreditAdjustmentKind) {
    const resolve = async (purpose: 'receivables' | 'customer_deposits' | 'credit_forfeit' | 'credit_adjustment') => (await this.setup.resolveCustomer(companyId, group, purpose)).accountId;
    interface Side { accountId: string; label: string; ledger?: 'customer' | 'wallet' }
    if (kind === 'waive_excess') {
      const [receivables, income] = await Promise.all([resolve('receivables'), resolve('credit_forfeit')]);
      return { debit: { accountId: receivables, label: 'Credit no longer owed', ledger: 'customer' } satisfies Side, credit: { accountId: income, label: 'Customer credit given up' } satisfies Side };
    }
    if (kind === 'wallet_increase') {
      const [deposits, cost] = await Promise.all([resolve('customer_deposits'), resolve('credit_adjustment')]);
      return { debit: { accountId: cost, label: 'Credit adjustment cost' } satisfies Side, credit: { accountId: deposits, label: 'Added to the wallet', ledger: 'wallet' } satisfies Side };
    }
    const [deposits, income] = await Promise.all([resolve('customer_deposits'), resolve('credit_forfeit')]);
    return { debit: { accountId: deposits, label: 'Taken from the wallet', ledger: 'wallet' } satisfies Side, credit: { accountId: income, label: kind === 'wallet_expiry' ? 'Wallet balance lapsed' : 'Taken off the wallet' } satisfies Side };
  }

  // ── the approval workflow decided (called by it, in its transaction) ─────

  async onApproved(tx: Tx, id: string): Promise<void> {
    const [a] = await tx.select().from(creditAdjustments).where(eq(creditAdjustments.id, id));
    if (!a) return;
    const [last] = await tx
      .select({ by: approvalRequests.requestedBy })
      .from(approvalRequests)
      .where(and(eq(approvalRequests.documentKind, 'credit_adjustment'), eq(approvalRequests.documentId, id)))
      .limit(1);
    const ctx: FinanceContext = { companyId: a.companyId, actor: { type: 'system', id: null }, origin: { surface: 'approvals', action: 'release_credit_adjustment' } };
    await this.applyIn(tx, ctx, id, last?.by ?? null);
  }

  async onRejected(tx: Tx, id: string, info: { reasonCode: string; comment: string }): Promise<void> {
    const [a] = await tx.select().from(creditAdjustments).where(eq(creditAdjustments.id, id)).for('update');
    if (a?.status !== 'pending_approval') return;
    const ctx: FinanceContext = { companyId: a.companyId, actor: { type: 'system', id: null }, origin: { surface: 'approvals', action: 'reject_credit_adjustment' } };
    await this.move(tx, a, 'rejected', { decidedAt: new Date() });
    await this.event(tx, ctx, id, 'rejected', a.status, 'rejected', { reason: { code: info.reasonCode, text: info.comment } });
  }

  async onReopened(tx: Tx, id: string): Promise<void> {
    const [a] = await tx.select().from(creditAdjustments).where(eq(creditAdjustments.id, id)).for('update');
    if (a?.status !== 'pending_approval') return;
    const ctx: FinanceContext = { companyId: a.companyId, actor: { type: 'system', id: null }, origin: { surface: 'approvals', action: 'reopen_credit_adjustment' } };
    await tx.update(creditAdjustments).set({ status: 'requested', updatedAt: new Date() }).where(eq(creditAdjustments.id, id));
    await this.event(tx, ctx, id, 'reopened', a.status, 'requested');
  }

  async onCanceled(tx: Tx, id: string): Promise<void> {
    const [a] = await tx.select().from(creditAdjustments).where(eq(creditAdjustments.id, id)).for('update');
    if (a?.status !== 'pending_approval') return;
    const ctx: FinanceContext = { companyId: a.companyId, actor: { type: 'system', id: null }, origin: { surface: 'approvals', action: 'withdraw_credit_adjustment' } };
    await this.move(tx, a, 'cancelled');
    await this.event(tx, ctx, id, 'cancelled', a.status, 'cancelled', { data: { by: 'approval withdrawn' } });
  }

  /** Stops a request that has not taken effect. */
  async cancel(ctx: FinanceContext, id: string, reason: { code: string; text?: string | null }): Promise<void> {
    const a0 = await this.db.select({ kind: creditAdjustments.kind }).from(creditAdjustments).where(and(eq(creditAdjustments.companyId, ctx.companyId), eq(creditAdjustments.id, id)));
    if (a0.length === 0) throw new FinanceError('NOT_FOUND', 'That credit adjustment does not exist.');
    const rs = await this.reasons.require(ctx.companyId, reason, a0[0].kind === 'waive_excess' ? 'refund' : 'wallet');
    const { getContainer } = await import('@/server/di/container');
    await this.db.transaction(async (tx) => {
      const a = await this.lock(tx, ctx.companyId, id);
      if (a.status === 'applied') throw new FinanceError('ALREADY_APPLIED', 'This has taken effect. To undo it, make the opposite adjustment.');
      if (a.status === 'cancelled' || a.status === 'rejected') throw new FinanceError('NOT_ACTIVE', `This credit adjustment is ${a.status}.`);
      if (a.status === 'pending_approval') {
        const [req] = await tx.select({ sub: approvalRequests.submissionId }).from(approvalRequests).where(and(eq(approvalRequests.documentKind, 'credit_adjustment'), eq(approvalRequests.documentId, id), eq(approvalRequests.status, 'pending'))).limit(1);
        if (req) await getContainer().approvals.cancel(req.sub, { userId: ctx.actor.id ?? '', isAdmin: true }, { text: rs.text ?? rs.code }, tx);
        const [fresh] = await tx.select().from(creditAdjustments).where(eq(creditAdjustments.id, id));
        if (fresh.status !== 'cancelled') await this.move(tx, fresh, 'cancelled');
      } else {
        await this.move(tx, a, 'cancelled');
      }
      await this.event(tx, ctx, id, 'cancelled', a.status, 'cancelled', { reason: rs });
      await this.decisions.record({ companyId: ctx.companyId, subject: { type: 'credit_adjustment', id }, action: 'finance.credit_adjustment_cancelled', actor: ctx.actor, from: a.status, to: 'cancelled', reason: rs, inputs: { origin: ctx.origin } }, tx);
    });
  }

  // ── balances that lapse ──────────────────────────────────────────────────

  /**
   * Wallets nobody has touched for as long as their policy allows lapse: the balance is taken off and becomes income. Safe to
   * run again and again: each wallet lapses once for the last time it was touched, and one wallet failing never stops the rest.
   */
  async expireDormant(now: Date, limit = 200): Promise<{ expired: number; failed: number }> {
    const companies = await this.db.selectDistinct({ id: customerCreditPolicies.companyId }).from(customerCreditPolicies).where(sql`${customerCreditPolicies.expiryDays} IS NOT NULL`);
    let expired = 0;
    let failed = 0;
    for (const { id: companyId } of companies) {
      await this.reasons.ensureSystemReasons(companyId);
      const [shortest] = await this.db.select({ d: sql<number | null>`min(${customerCreditPolicies.expiryDays})::int` }).from(customerCreditPolicies).where(and(eq(customerCreditPolicies.companyId, companyId), sql`${customerCreditPolicies.expiryDays} IS NOT NULL`));
      if (shortest.d === null) continue;
      const cutoff = new Date(now.getTime() - shortest.d * 86_400_000);
      const wallets = await this.db
        .select()
        .from(customerWallets)
        .where(and(eq(customerWallets.companyId, companyId), eq(customerWallets.status, 'active'), sql`${customerWallets.balance} > 0`, lt(customerWallets.updatedAt, cutoff)))
        .orderBy(asc(customerWallets.updatedAt))
        .limit(limit);
      for (const w of wallets) {
        try {
          if (await this.expireOne(companyId, w.id, now)) expired += 1;
        } catch (error) {
          failed += 1;
          console.error('[wallet] a balance could not be lapsed', w.id, error instanceof Error ? error.message : error);
        }
      }
    }
    return { expired, failed };
  }

  private async expireOne(companyId: string, walletId: string, now: Date): Promise<boolean> {
    const ctx: FinanceContext = { companyId, actor: { type: 'job', id: 'wallet-expiry' }, origin: { surface: 'jobs/wallet-expiry', action: 'lapse_balance' } };
    return await this.db.transaction(async (tx) => {
      const [w] = await tx.select().from(customerWallets).where(eq(customerWallets.id, walletId)).for('update');
      if (w?.status !== 'active' || toCents(w.balance) <= 0) return false;
      const policy = await this.policies.forCustomer(tx, companyId, w.customerId, businessDate(now));
      if (expiryState(w.updatedAt, now, policy) !== 'lapsed') return false;
      const key = `expiry:${w.id}:${w.updatedAt.toISOString()}`;
      const [dup] = await tx.select({ id: creditAdjustments.id }).from(creditAdjustments).where(and(eq(creditAdjustments.companyId, companyId), eq(creditAdjustments.idempotencyKey, key)));
      if (dup) return false;
      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('credit_adjustment', { companyId, branchId: undefined, date: businessDate(now), document: { kind: 'credit_adjustment', id }, actor: ctx.actor }, tx);
      await tx.insert(creditAdjustments).values({ id, companyId, number, kind: 'wallet_expiry', customerId: w.customerId, sourceKind: 'wallet', sourceId: w.id, currency: w.currency, amount: w.balance, reasonCode: 'CREDIT_LAPSED', reasonText: `Not used for ${String(policy.expiryDays)} days`, requestedBy: 'wallet-expiry', idempotencyKey: key });
      await this.event(tx, ctx, id, 'requested', null, 'requested', { reason: { code: 'CREDIT_LAPSED' }, data: { kind: 'wallet_expiry', amount: w.balance, lastTouched: w.updatedAt.toISOString() } });
      await this.applyIn(tx, ctx, id, 'wallet-expiry');
      return true;
    });
  }

  /** Balances about to lapse, so someone can tell the customer: the soonest first. */
  async expiringSoon(companyId: string, now: Date, limit = 50) {
    const rows = await this.db
      .select({ w: customerWallets, name: customers.name, number: customers.number })
      .from(customerWallets)
      .innerJoin(customers, eq(customers.id, customerWallets.customerId))
      .where(and(eq(customerWallets.companyId, companyId), eq(customerWallets.status, 'active'), sql`${customerWallets.balance} > 0`))
      .orderBy(asc(customerWallets.updatedAt))
      .limit(500);
    const out: { walletId: string; customerId: string; customer: string; number: string; balance: string; currency: string; lastTouched: string; state: 'soon' | 'lapsed'; expiryDays: number }[] = [];
    for (const r of rows) {
      const policy = await this.policies.forCustomer(this.db, companyId, r.w.customerId, businessDate(now));
      if (policy.expiryDays === null) continue;
      const state = expiryState(r.w.updatedAt, now, policy);
      if (state === 'soon' || state === 'lapsed') out.push({ walletId: r.w.id, customerId: r.w.customerId, customer: r.name, number: r.number, balance: r.w.balance, currency: r.w.currency, lastTouched: r.w.updatedAt.toISOString(), state, expiryDays: policy.expiryDays });
      if (out.length >= limit) break;
    }
    return out;
  }

  // ── reads ────────────────────────────────────────────────────────────────

  async list(companyId: string, f: { status?: CreditAdjustmentStatus; kind?: CreditAdjustmentKind; q?: string; before?: string; limit?: number } = {}) {
    const limit = Math.min(f.limit ?? 50, 200);
    const q = f.q?.trim();
    const rows = await this.db
      .select({ a: creditAdjustments, customerName: customers.name, customerNumber: customers.number })
      .from(creditAdjustments)
      .innerJoin(customers, eq(customers.id, creditAdjustments.customerId))
      .where(and(eq(creditAdjustments.companyId, companyId), has(f.status) ? eq(creditAdjustments.status, f.status) : undefined, has(f.kind) ? eq(creditAdjustments.kind, f.kind) : undefined, has(f.before) ? lt(creditAdjustments.createdAt, new Date(f.before)) : undefined, has(q) ? or(ilike(creditAdjustments.number, `%${q}%`), ilike(customers.name, `%${q}%`), ilike(customers.number, `%${q}%`)) : undefined))
      .orderBy(desc(creditAdjustments.createdAt))
      .limit(limit + 1);
    const more = rows.length > limit;
    const page = more ? rows.slice(0, limit) : rows;
    return { rows: page, nextBefore: more ? page[page.length - 1].a.createdAt.toISOString() : null };
  }

  async detail(companyId: string, id: string) {
    const [head] = await this.db
      .select({ a: creditAdjustments, customer: customers })
      .from(creditAdjustments)
      .innerJoin(customers, eq(customers.id, creditAdjustments.customerId))
      .where(and(eq(creditAdjustments.companyId, companyId), eq(creditAdjustments.id, id)));
    if (!head) return null;
    const [events, source] = await Promise.all([
      this.db.select().from(creditAdjustmentEvents).where(eq(creditAdjustmentEvents.adjustmentId, id)).orderBy(asc(creditAdjustmentEvents.id)),
      has(head.a.sourceKind) && has(head.a.sourceId) ? this.refunds.openOf(this.db, companyId, head.a.sourceKind, head.a.sourceId, head.a.customerId) : Promise.resolve(null),
    ]);
    const ids = [...new Set([...events.map((e) => e.actorId), head.a.requestedBy, head.a.decidedBy])].filter((x): x is string => typeof x === 'string' && /^[0-9a-f-]{36}$/i.test(x));
    const named = ids.length !== 0 ? await this.db.select({ id: users.id, name: users.name, email: users.email }).from(users).where(inArray(users.id, ids)) : [];
    return { ...head, events, sourceLabel: source?.label ?? '', actors: Object.fromEntries(named.map((u) => [u.id, orElse(u.name, u.email)])), capabilities: adjustmentCapabilities(head.a.status) };
  }
}
