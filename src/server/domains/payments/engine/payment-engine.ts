import { and, eq, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { paymentAttempts, paymentMethods, type ProviderOperationRow } from '@/server/db/drizzle/schema';
import type { C2bConsumer, DarajaC2b } from '../daraja/c2b';
import type { PaymentService } from '../service';
import type { DarajaOperations } from '../daraja/operations';
import type { DarajaDisbursements } from '../daraja/disbursements';
import { parseB2bExpress, parseBillPayment, parseC2b } from '../daraja/parsers';
import { looksLikeReceipt } from '../daraja/security';
import { DARAJA_OPERATIONS, type DarajaOperationCode } from '../daraja/catalog';
import { readStatusAnswer, statusAgrees } from '../daraja/verify';
import type { PaymentRegistry } from '../registry';
import type { PlatformContexts } from './context';
import type { ProviderEventService } from './event-service';
import type { PaymentJobs } from './jobs';
import type { ProviderOperationService } from './operation-service';
import { engineSettings } from './settings';
import type { ProviderTransactionStore } from './transaction-store';
import type { PaymentVerificationService } from './verification-service';

import { has, orElse } from '@/lib/values';
import type { PaymentActivityService } from './activity-service';
import type { BillInvoiceService } from './bill-invoice-service';

export interface IngestInput {
  rawText: string;
  headers: Record<string, string>;
  sourceIp: string | null;
  https: boolean;
  method: string;
}

export interface IngestReply {
  httpStatus: number;
  body: Record<string, unknown>;
}

const ACK = { ResultCode: 0, ResultDesc: 'Accepted' };

export type HookKind = 'c2b-validate' | 'c2b-confirm' | 'result' | 'timeout' | 'bill' | 'express' | 'pull';

/**
 * The only doors payment platforms knock on. Each one writes down what arrived (who sent it, whether it
 * could be trusted, what it said), answers quickly in the form the platform expects, and hands the rest to
 * the job queue. Nothing is believed here; believing is the verification service's job.
 */
/** The name an inbound notice is recorded under. */
function eventKindName(kind: string): string {
  if (kind === 'c2b-validate') return 'c2b_validation';
  return kind === 'c2b-confirm' ? 'c2b_confirmation' : kind;
}

/** The kind of C2B payment notice a kind of inbound call carries, if it carries one. */
function c2bClaimKind(kind: string): 'c2b_validation' | 'c2b_confirmation' | null {
  if (kind === 'c2b-validate') return 'c2b_validation';
  return kind === 'c2b-confirm' ? 'c2b_confirmation' : null;
}

export class PaymentEngine {
  /** Read-only views for the people watching over payments. */
  activity!: PaymentActivityService;
  /** Invoices sent through Bill Manager, followed to the receipt. */
  bills!: BillInvoiceService;

  constructor(
    readonly db: DrizzleDb,
    readonly contexts: PlatformContexts,
    private readonly registry: PaymentRegistry,
    readonly events: ProviderEventService,
    readonly ops: ProviderOperationService,
    readonly txs: ProviderTransactionStore,
    readonly jobs: PaymentJobs,
    readonly verification: PaymentVerificationService,
    readonly daraja: DarajaOperations,
    readonly c2b: DarajaC2b,
    readonly disbursements: DarajaDisbursements,
    private readonly payments: PaymentService,
    private readonly consumer: C2bConsumer | null,
  ) {}

  private parseBody(input: IngestInput, query?: Record<string, string>): unknown {
    if (query && Object.keys(query).length > 0 && !has(input.rawText.trim())) return query;
    try {
      return has(input.rawText) ? JSON.parse(input.rawText) : null;
    } catch {
      return null;
    }
  }

  /** A callback addressed to one payment we started (its address carries that payment's own secret). */
  /** Found by its secret address, or (for notifications sent to an address with no secret) by the platform's own id for it. */
  private async attemptFor(token: string | undefined, trackingId: string | undefined) {
    if (has(token)) return (await this.db.select().from(paymentAttempts).where(eq(paymentAttempts.callbackToken, token))).at(0);
    if (has(trackingId)) return (await this.db.select().from(paymentAttempts).where(eq(paymentAttempts.externalReference, trackingId)).limit(1)).at(0);
    return undefined;
  }

  async ingestAttemptCallback(input: IngestInput & { token?: string; trackingId?: string; query?: Record<string, string> }): Promise<IngestReply> {
    const attempt = await this.attemptFor(input.token, input.trackingId);
    if (attempt === undefined) return { httpStatus: 404, body: { ResultCode: 1, ResultDesc: 'Unknown callback address' } };
    const ctx = await this.contexts.forProvider(attempt.providerConfigId);
    const settings = engineSettings(ctx.settings);
    const refusal = this.events.guard(settings, { sourceIp: input.sourceIp, size: Buffer.byteLength(input.rawText), https: input.https, requireHttps: ctx.provider.environment === 'production' });
    const body = this.parseBody(input, input.query);
    const providerCode = attempt.providerCode;
    const adapter = this.registry.resolve(providerCode);
    const claim = refusal ? null : (adapter.parseCallback?.(body) ?? null);
    const rawText = orElse(input.rawText, input.query ? JSON.stringify(input.query) : '');
    const { event } = await this.events.record({
      companyId: ctx.companyId,
      providerId: ctx.provider.id,
      kind: claim?.kind ?? (providerCode === 'pesapal_v3' ? 'ipn' : 'callback'),
      sourceIp: input.sourceIp,
      headers: input.headers,
      rawText,
      attemptId: attempt.id,
      claim: claim ? (claim as unknown as Record<string, unknown>) : null,
      rejected: refusal ?? undefined,
    });
    if (refusal) return { httpStatus: 403, body: { ResultCode: 1, ResultDesc: 'Not accepted' } };
    if (!claim && adapter.parseCallback) {
      await this.events.setState(event.id, 'mismatch', { failureCode: 'UNREADABLE', failureReason: 'The callback could not be read as a payment notification.' });
    } else if (claim) {
      await this.events.setState(event.id, 'awaiting_verification', { platformReference: claim.platformReference, amount: claim.amountCents === null ? undefined : (claim.amountCents / 100).toFixed(2) });
    }
    // (A platform with no way to read its callbacks keeps the event as received; it is never counted without a check.)
    try {
      await this.jobs.verifyAttempt(attempt.id, 0);
    } catch (error) {
      console.error('[payments] could not queue the verification', error);
      return { httpStatus: 503, body: { ResultCode: 1, ResultDesc: 'Could not be queued' } };
    }
    return { httpStatus: 200, body: ACK };
  }

  /** Callbacks addressed to a provider: paybill/till payments, results and timeouts of requests we made. */
  async ingestHook(input: IngestInput & { providerId: string; kind: HookKind; secret: string }): Promise<IngestReply> {
    let ctx;
    try {
      ctx = await this.contexts.forProvider(input.providerId);
    } catch {
      return { httpStatus: 404, body: { ResultCode: 1, ResultDesc: 'Unknown' } };
    }
    if (ctx.provider.providerCode !== 'mpesa_daraja') return { httpStatus: 404, body: { ResultCode: 1, ResultDesc: 'Unknown' } };
    const settings = engineSettings(ctx.settings);
    const trusted = await this.contexts.checkSecret(ctx.provider.id, input.secret);
    const refusal = !trusted
      ? { code: 'BAD_SECRET', reason: 'The secret in the address is not this provider\'s.' }
      : this.events.guard(settings, { sourceIp: input.sourceIp, size: Buffer.byteLength(input.rawText), https: input.https, requireHttps: ctx.provider.environment === 'production' });
    const body = this.parseBody(input);
    const kindName = eventKindName(input.kind);
    const c2bKind = c2bClaimKind(input.kind);
    const claim = refusal !== null || c2bKind === null ? null : parseC2b(c2bKind, body);
    const { event } = await this.events.record({
      companyId: ctx.companyId,
      providerId: ctx.provider.id,
      kind: kindName,
      sourceIp: input.sourceIp,
      headers: input.headers,
      rawText: input.rawText,
      claim: claim ? (claim as unknown as Record<string, unknown>) : null,
      rejected: refusal ?? undefined,
    });
    if (refusal) return { httpStatus: refusal.code === 'BAD_SECRET' ? 404 : 403, body: { ResultCode: 1, ResultDesc: 'Not accepted' } };

    switch (input.kind) {
      case 'c2b-validate':
        return { httpStatus: 200, body: await this.c2b.validate(event, claim, ctx.provider.id) };
      case 'c2b-confirm':
        await this.c2b.confirmed(event, claim, ctx.provider.id);
        return { httpStatus: 200, body: { ResultCode: '0', ResultDesc: 'Success' } };
      case 'result': {
        const done = await this.daraja.completeFromResult(ctx.provider.id, body);
        if (!done.matched) {
          await this.events.setState(event.id, 'unmatched', { failureCode: 'NO_OPERATION', failureReason: done.reason ?? 'No operation of ours matches this result.' });
        } else if (done.op) {
          await this.events.setState(event.id, 'verified', { operationId: done.op.id, failureCode: null, failureReason: null });
          if (DARAJA_OPERATIONS[done.op.operation as DarajaOperationCode].moneyOut && done.op.status === 'accepted') await this.checkPayout(done.op.id);
          else await this.finished(done.op.id);
          await this.followUp(done.op.subjectType, done.op.subjectId);
        }
        return { httpStatus: 200, body: ACK };
      }
      case 'timeout': {
        const done = await this.daraja.markTimedOut(ctx.provider.id, body);
        await this.events.setState(event.id, done.matched ? 'verified' : 'unmatched', done.matched ? { operationId: done.op?.id } : { failureCode: 'NO_OPERATION', failureReason: 'No operation of ours matches this timeout notice.' });
        if (done.op) await this.followUp(done.op.subjectType, done.op.subjectId);
        return { httpStatus: 200, body: ACK };
      }
      case 'express': {
        const claim = parseB2bExpress(body);
        const op = has(claim?.originatorId) ? await this.ops.byOriginator(ctx.provider.id, claim.originatorId) : null;
        if (claim === null || op?.operation !== 'b2b_express') {
          await this.events.setState(event.id, 'unmatched', { failureCode: 'NO_OPERATION', failureReason: 'No B2B Express Checkout request of ours has this reference.' });
          return { httpStatus: 200, body: ACK };
        }
        if (!['succeeded', 'failed', 'cancelled', 'rejected'].includes(op.status)) {
          if (claim.claimsSuccess === true && has(claim.platformReference) && looksLikeReceipt(claim.platformReference)) {
            await this.ops.update(op.id, { status: 'succeeded', platformReference: claim.platformReference, result: { callback: true, amountCents: claim.amountCents, confirmedBy: 'callback_only' } });
            // The other business's word is only a claim: the payment is written down under its M-Pesa code, checked with
            // Safaricom, and put on a customer only after that.
            await this.c2b.expressPaid(event, claim, ctx.provider.id, op.methodId);
            return { httpStatus: 200, body: ACK };
          } else if (claim.claimsSuccess === false) {
            await this.ops.update(op.id, { status: 'failed', failureCode: claim.failureCode ?? 'DECLINED', failureReason: claim.failureReason ?? 'The other business did not complete the payment.' });
          } else {
            await this.ops.update(op.id, { status: 'in_doubt', failureCode: 'UNCLEAR', failureReason: 'The callback did not say clearly whether it was paid. Check the M-Pesa statement.', nextAttemptAt: null });
          }
        }
        // A payment that was not clearly made is never credited; the callback is kept as it came.
        await this.events.setState(event.id, 'unverified', { operationId: op.id, failureCode: 'CALLBACK_ONLY', failureReason: 'The callback did not clearly say the payment was made, so nothing is credited from it.' });
        return { httpStatus: 200, body: ACK };
      }
      case 'bill': {
        // A Bill Manager payment notice is a claim like any other: written down under its M-Pesa code, checked with Safaricom,
        // then put on the customer. The same payment announced by the paybill itself is counted once.
        const paid = parseBillPayment(body);
        if (paid) await this.c2b.billNoticed(event, paid, ctx.provider.id);
        else await this.events.setState(event.id, 'unverified', { failureCode: 'NOT_A_PAYMENT', failureReason: 'This Bill Manager notice is not a payment notice, so it is kept as a record.' });
        return { httpStatus: 200, body: ACK };
      }
      case 'pull':
        // A Pull notice is kept for the record; payments are found by asking Safaricom, never taken from the notice.
        await this.events.setState(event.id, 'unverified', { failureCode: 'RECORD_ONLY', failureReason: 'Pull notifications are kept as a record; nothing is credited from them.' });
        return { httpStatus: 200, body: ACK };
    }
  }

  /** A payout reported success on its callback: ask Safaricom for its own record of that transaction before counting it. */
  private async checkPayout(opId: string) {
    const op = await this.ops.get(opId);
    if (op?.status !== 'accepted' || !has(op.platformReference)) return;
    try {
      // Each check is its own request, so asking again after a doubt is a new question, not the old answer.
      const asked = (await this.ops.bySubject('provider_operation', op.id, 'transaction_status')).length;
      await this.daraja.start({ providerId: op.providerId, methodId: op.methodId, operation: 'transaction_status', input: { transactionId: op.platformReference }, idempotencyKey: `payout-check:${op.id}:${String(asked + 1)}`, subject: { type: 'provider_operation', id: op.id } });
    } catch (error) {
      await this.ops.update(op.id, { status: 'in_doubt', failureCode: 'CHECK_NOT_RUN', failureReason: `The payout was reported as done, but it could not be checked with Safaricom (${error instanceof Error ? error.message : 'unknown error'}). Check the M-Pesa statement.`, nextAttemptAt: null });
    }
  }

  /** The check of a payout finished: it counts as paid only if Safaricom's record agrees on the transaction, status and amount. */
  private async settlePayout(opId: string) {
    const op = await this.ops.get(opId);
    if (op?.status !== 'accepted' || !has(op.platformReference)) return;
    const check = (await this.ops.bySubject('provider_operation', op.id, 'transaction_status')).at(-1);
    if (!check || ['created', 'queued', 'submitted', 'accepted', 'timed_out'].includes(check.status)) return;
    if (check.status !== 'succeeded') {
      await this.ops.update(op.id, { status: 'in_doubt', failureCode: 'CHECK_FAILED', failureReason: `Safaricom's record of the payout could not be read (${check.failureReason ?? check.status}). Check the M-Pesa statement before doing anything else.`, nextAttemptAt: null });
      await this.finished(op.id);
      return;
    }
    const answer = readStatusAnswer(check.result);
    const verdict = answer ? statusAgrees(answer, { receipt: op.platformReference, amountCents: Math.round(Number(op.amount ?? 0) * 100), shortcode: null }) : { ok: false as const, code: 'STATUS_UNREADABLE', reason: "Safaricom's answer could not be read." };
    const done = async () => await this.finished(op.id);
    if (verdict.ok) await this.ops.update(op.id, { status: 'succeeded', failureCode: null, failureReason: null, result: { ...(op.result), verifiedBy: 'transaction_status', checkOperationId: check.id } });
    else await this.ops.update(op.id, { status: 'in_doubt', failureCode: verdict.code, failureReason: `${verdict.reason} The payout is not counted until a person has checked it.`, nextAttemptAt: null });
    await done();
  }

  /** A status check finished: whoever was waiting for it can carry on. */
  private async followUp(subjectType: string | null, subjectId: string | null) {
    if (!has(subjectType) || !has(subjectId)) return;
    if (subjectType === 'provider_operation') await this.settlePayout(subjectId);
    if (subjectType === 'payment_attempt') await this.jobs.verifyAttempt(subjectId, 0);
    if (subjectType === 'provider_transaction') await this.jobs.verifyTransaction(subjectId, 0);
  }

  /** The once-a-minute safety net: anything a lost job or a restart left half done is picked up again. */
  /** Told when a payout finishes (paid, failed or held), so what it was for can follow. */
  payoutConsumer: { finished(op: ProviderOperationRow): Promise<void> } | null = null;

  private async finished(opId: string) {
    const op = await this.ops.get(opId);
    if (!op || !this.payoutConsumer || !DARAJA_OPERATIONS[op.operation as DarajaOperationCode].moneyOut) return;
    if (!['succeeded', 'failed', 'in_doubt', 'rejected', 'cancelled'].includes(op.status)) return;
    await this.payoutConsumer.finished(op).catch(() => undefined);
  }

  async sweep(): Promise<{ resent: number; claimed: number; pending: number }> {
    let resent = 0;
    for (const op of await this.ops.due(100)) {
      if (op.status === 'queued') {
        await this.daraja.send(op.id);
        resent += 1;
      } else if (op.operation === 'stk_push' && ['accepted', 'submitted'].includes(op.status)) {
        // The outcome of a customer prompt is seen on the payment it belongs to, not on a result address.
        const [attempt] = has(op.subjectId) ? await this.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, op.subjectId)) : [];
        if (attempt?.status === 'successful') await this.ops.update(op.id, { status: 'succeeded', platformReference: attempt.providerReference });
        else if (attempt && ['failed', 'cancelled', 'expired'].includes(attempt.status)) await this.ops.update(op.id, { status: 'failed', failureCode: 'PAYMENT_FAILED', failureReason: attempt.errorMessage ?? 'The customer did not complete the payment.' });
        else await this.ops.update(op.id, { nextAttemptAt: new Date(Date.now() + 10 * 60_000) });
      } else if (['accepted', 'submitted', 'timed_out'].includes(op.status)) {
        // No answer came. A query is safe to give up on; anything that moved money would be checked, never assumed.
        const query = ['transaction_status', 'stk_query', 'pull_query'].includes(op.operation);
        if (query) await this.ops.update(op.id, { status: 'failed', failureCode: 'NO_RESULT', failureReason: 'Safaricom did not send an answer in time.' });
        else {
          await this.ops.update(op.id, { status: 'in_doubt', failureCode: 'NO_RESULT', failureReason: 'No answer arrived. It must be checked with the platform before anything is done again.', nextAttemptAt: null });
          await this.finished(op.id);
        }
        if (query && has(op.subjectType)) await this.followUp(op.subjectType, op.subjectId);
      }
    }
    const claimed = await this.c2b.sweepClaimed();
    const pending = await this.sweepAttempts();
    return { resent, claimed, pending };
  }

  // ── what a person may do when the engine cannot decide ──────────────────

  /**
   * A payout left in doubt that Safaricom gave a receipt for: ask Safaricom again about that transaction. If its own record
   * agrees on the transaction, status and amount the payout counts as paid; otherwise it stays in doubt with the reason.
   */
  async recheckPayout(opId: string): Promise<{ ok: true } | { ok: false; error: string }> {
    const op = await this.ops.get(opId);
    if (!op || !DARAJA_OPERATIONS[op.operation as DarajaOperationCode].moneyOut) return { ok: false, error: 'That is not a payout.' };
    if (!['in_doubt', 'timed_out'].includes(op.status)) return { ok: false, error: `Only a payout that is in doubt can be checked again; this one is ${op.status.replace('_', ' ')}.` };
    if (!has(op.platformReference)) return { ok: false, error: 'Safaricom never gave a transaction number for this payout, so there is nothing to look up. Check the M-Pesa statement and close the attempt with what you find.' };
    await this.ops.update(op.id, { status: 'accepted', failureCode: null, failureReason: null });
    await this.checkPayout(op.id);
    return { ok: true };
  }

  /**
   * A person closes a payout that could not be confirmed, after looking at the M-Pesa statement. If the money did leave, the
   * refund is then recorded by hand with the statement's receipt; if it did not, the refund can be sent again. Kept with their name.
   */
  async closeDoubtfulPayout(input: { opId: string; userId: string; reason: string; moneyLeft: boolean }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (input.reason.trim().length < 10) return { ok: false, error: 'Say what you found on the statement (at least a sentence): this is kept with your name.' };
    const op = await this.ops.get(input.opId);
    if (!op || !DARAJA_OPERATIONS[op.operation as DarajaOperationCode].moneyOut) return { ok: false, error: 'That is not a payout.' };
    if (!['in_doubt', 'timed_out'].includes(op.status)) return { ok: false, error: `Only a payout that is in doubt can be closed; this one is ${op.status.replace('_', ' ')}.` };
    await this.ops.update(op.id, {
      status: 'failed',
      failureCode: input.moneyLeft ? 'CLOSED_MONEY_LEFT' : 'CLOSED_NOT_PAID',
      failureReason: `Closed by a person who checked the statement: ${input.reason.trim()}`,
      result: { ...op.result, closedBy: input.userId, moneyLeft: input.moneyLeft, closedReason: input.reason.trim() },
    });
    await this.finished(op.id);
    return { ok: true };
  }

  /** Re-run the check for a payment right now. */
  async recheck(attemptId: string) {
    await this.jobs.verifyAttempt(attemptId, 0);
  }

  /**
   * A person confirms a payment the platform could not be asked about (or never decided): they give the
   * platform's own transaction number and the reason, and it is recorded as theirs. Never for a payment the
   * platform contradicted.
   */
  async confirmAttemptManually(input: { attemptId: string; reference: string; reason: string; userId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    const reference = input.reference.trim();
    if (reference.length < 4 || reference.length > 40 || reference.startsWith('ws_CO_')) return { ok: false, error: "Enter the platform's own transaction number (for M-Pesa, the receipt such as NLJ7RT61SV)." };
    if (input.reason.trim().length < 10) return { ok: false, error: 'Say why you are confirming it (at least a sentence): this is kept with your name.' };
    const [attempt] = await this.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, input.attemptId));
    if (!attempt) return { ok: false, error: 'That payment does not exist.' };
    if (['successful', 'cancelled'].includes(attempt.status)) return { ok: false, error: `This payment is already ${attempt.status}.` };
    const [latest] = await this.events.forAttempt(attempt.id);
    if (latest?.state === 'mismatch') return { ok: false, error: 'The platform or our own checks contradict this payment (see its history). It cannot be confirmed by hand.' };
    const ctx = await this.contexts.forProvider(attempt.providerConfigId);
    const claimed = await this.txs.claim({ companyId: ctx.companyId, providerId: ctx.provider.id, kind: 'gateway', platformReference: reference, amount: (Math.round(Number(attempt.amount) * 100) / 100).toFixed(2), currency: attempt.currency });
    if (!claimed.created && claimed.row.consumedAt) return { ok: false, error: `${reference} has already been counted for something else.` };
    if (claimed.amountDiffers) return { ok: false, error: `${reference} is already recorded for a different amount.` };
    await this.txs.addEvidence(claimed.row.id, { manual: true, by: input.userId, reason: input.reason.trim() }, 'manual');
    await this.txs.setState(claimed.row.id, 'verified', { verifiedBy: 'manual' });
    await this.events.record({ companyId: ctx.companyId, providerId: ctx.provider.id, kind: 'manual_confirmation', sourceIp: null, headers: {}, rawText: JSON.stringify({ by: input.userId, reference, reason: input.reason.trim() }), attemptId: attempt.id });
    const done = await this.payments.succeed(attempt.id, { reference, verifiedBy: 'manual', transactionId: claimed.row.id });
    if (done.settled) await this.txs.consume(claimed.row.id, 'payment_attempt', attempt.id);
    return { ok: true };
  }

  /** A person closes a payment that never completed. */
  async failAttemptManually(input: { attemptId: string; reason: string; userId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (input.reason.trim().length < 10) return { ok: false, error: 'Say why (at least a sentence): this is kept with your name.' };
    const [attempt] = await this.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, input.attemptId));
    if (!attempt) return { ok: false, error: 'That payment does not exist.' };
    if (['successful', 'cancelled', 'failed'].includes(attempt.status)) return { ok: false, error: `This payment is already ${attempt.status}.` };
    const ctx = await this.contexts.forProvider(attempt.providerConfigId);
    await this.events.record({ companyId: ctx.companyId, providerId: ctx.provider.id, kind: 'manual_failure', sourceIp: null, headers: {}, rawText: JSON.stringify({ by: input.userId, reason: input.reason.trim() }), attemptId: attempt.id });
    await this.payments.fail(attempt.id, { reason: `Closed by a person: ${input.reason.trim()}`, code: 'MANUAL' });
    return { ok: true };
  }

  /** A payment Safaricom confirmed that nobody could place: a person chooses the customer. */
  async placeTransaction(input: { transactionId: string; customerId: string; userId: string }): Promise<{ ok: true; type: string; id: string } | { ok: false; error: string }> {
    const tx = await this.txs.get(input.transactionId);
    if (!tx) return { ok: false, error: 'That payment does not exist.' };
    if (tx.state !== 'review') return { ok: false, error: `Only a confirmed payment waiting to be placed can be placed; this one is ${tx.state}.` };
    if (!this.consumer) return { ok: false, error: 'Placing payments is not set up.' };
    const [method] = has(tx.methodId) ? await this.db.select().from(paymentMethods).where(eq(paymentMethods.id, tx.methodId)) : [];
    if (!method) return { ok: false, error: 'No payment method is set up for the shortcode this was paid to.' };
    try {
      const placed = await this.consumer.place(tx, method, input.customerId, { id: input.userId });
      await this.txs.consume(tx.id, placed.type, placed.id);
      await this.c2b.notePlaced(tx.id);
      return { ok: true, ...placed };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : 'It could not be placed.' };
    }
  }

  /** A confirmed payment that is not ours to account for (paid to the wrong number, say), set aside with the reason. */
  async setAsideTransaction(input: { transactionId: string; reason: string; userId: string }): Promise<{ ok: true } | { ok: false; error: string }> {
    if (input.reason.trim().length < 10) return { ok: false, error: 'Say why (at least a sentence): this is kept with your name.' };
    const tx = await this.txs.get(input.transactionId);
    if (tx?.state !== 'review') return { ok: false, error: 'Only a confirmed payment waiting to be placed can be set aside.' };
    await this.txs.addEvidence(tx.id, { setAside: true, by: input.userId, reason: input.reason.trim() }, 'manual');
    await this.txs.setState(tx.id, 'rejected', { failureCode: 'SET_ASIDE', failureReason: `Set aside by a person: ${input.reason.trim()}` });
    return { ok: true };
  }

  /** Safety net: payments still waiting inside their window whose check might have been lost. Never pulls a later check forward. */
  async sweepAttempts(): Promise<number> {
    const rows = await this.db
      .select({ id: paymentAttempts.id })
      .from(paymentAttempts)
      .where(and(eq(paymentAttempts.status, 'pending'), sql`${paymentAttempts.createdAt} < now() - interval '3 minutes'`, sql`${paymentAttempts.createdAt} > now() - interval '3 hours'`))
      .limit(500);
    for (const r of rows) await this.jobs.verifyAttempt(r.id, 0, 'preserve_run_at');
    return rows.length;
  }
}
