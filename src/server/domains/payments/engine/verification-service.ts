import { eq } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { paymentAttempts, providerOperations, type PaymentAttemptRow, type ProviderEventRow } from '@/server/db/drizzle/schema';
import type { PaymentRegistry } from '../registry';
import type { PlatformContexts } from './context';
import type { ProviderEventService } from './event-service';
import type { PaymentJobs } from './jobs';
import type { ProviderOperationService } from './operation-service';
import { delayForAge, engineSettings } from './settings';
import type { ProviderTransactionStore } from './transaction-store';
import type { InboundClaim, VerificationOutcome, VerifyAttemptInput } from './types';

import { has } from '@/lib/values';

/** What counting a verified payment means. The payment domain implements it; the engine only decides when. */
export interface AttemptSettler {
  /** Has a verified transaction already been counted for this attempt? */
  isSettled(attemptId: string): Promise<boolean>;
  succeed(attemptId: string, input: { reference: string | null; verifiedBy: string; transactionId: string }): Promise<{ settled: boolean }>;
  fail(attemptId: string, input: { reason: string; code: string | null }): Promise<{ settled: boolean }>;
}

/** Starts the transaction-level check when a strict verification needs it. */
export interface StatusCheckStarter {
  checkTransaction(input: { providerId: string; attemptId: string; receipt: string; shortcode: string | null }): Promise<void>;
}

export interface VerifyResult {
  outcome: VerificationOutcome['status'] | 'already_final' | 'no_attempt';
  reason?: string;
}

const FINAL_ATTEMPT = new Set(['successful', 'failed', 'cancelled']);

/**
 * The one place a gateway payment becomes real. A callback only tells us where to look. We ask the
 * platform ourselves, compare its answer with what we asked for, and only then count the payment, once.
 * If the platform cannot be asked, or contradicts the callback, the payment is left alone and the
 * reason is written down.
 */
export class PaymentVerificationService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly contexts: PlatformContexts,
    private readonly registry: PaymentRegistry,
    private readonly events: ProviderEventService,
    private readonly ops: ProviderOperationService,
    private readonly txs: ProviderTransactionStore,
    private readonly jobs: PaymentJobs,
    private readonly settler: AttemptSettler,
    private readonly checks: StatusCheckStarter | null = null,
  ) {}

  /** The newest callback of an attempt that said something we can read. */
  private async latestClaim(attemptId: string): Promise<{ event: ProviderEventRow | null; claim: InboundClaim | null }> {
    const all = await this.events.forAttempt(attemptId);
    const usable = all.filter((e) => e.state !== 'rejected');
    // A callback we could not read as a claim is still the latest word from the platform.
    if (usable.length > 0 && !usable.some((e) => e.claim)) return { event: usable[0], claim: null };
    for (const event of usable) {
      if (event.claim) {
        const c = event.claim as unknown as InboundClaim;
        // Stored as JSON, so the date comes back as text.
        return { event, claim: { ...c, occurredAt: c.occurredAt ? new Date(c.occurredAt) : null } };
      }
    }
    return { event: null, claim: null };
  }

  /** The transaction-level answers already gathered for an attempt (for strict checks). */
  private async gatheredEvidence(attemptId: string): Promise<Record<string, unknown>[]> {
    const rows = await this.db.select().from(providerOperations).where(eq(providerOperations.subjectId, attemptId));
    return rows
      .filter((o) => o.subjectType === 'payment_attempt' && o.operation === 'transaction_status' && ['succeeded', 'failed'].includes(o.status))
      .map((o) => ({ by: 'transaction_status', ok: o.status === 'succeeded', result: o.result }));
  }

  async verifyAttempt(attemptId: string): Promise<VerifyResult> {
    const [attempt] = await this.db.select().from(paymentAttempts).where(eq(paymentAttempts.id, attemptId));
    if (!attempt) return { outcome: 'no_attempt' };
    // Finished: failed, cancelled, or paid and counted. (Paid but not yet counted is finished off below.)
    if (FINAL_ATTEMPT.has(attempt.status) && (attempt.status !== 'successful' || (await this.settler.isSettled(attempt.id)))) return { outcome: 'already_final' };
    const ctx = await this.contexts.forProvider(attempt.providerConfigId);
    const settings = engineSettings(ctx.settings);
    const adapter = this.registry.resolve(attempt.providerCode);
    const { event, claim } = await this.latestClaim(attempt.id);

    if (!adapter.verifyAttempt) {
      const reason = `${attempt.providerCode} has no way for us to check a payment with the platform, so it is not counted automatically. A person must confirm it (Payments → activity).`;
      if (event) await this.events.setState(event.id, 'unverified', { failureCode: 'NO_VERIFICATION', failureReason: reason });
      return { outcome: 'unavailable', reason };
    }

    const input: VerifyAttemptInput = {
      attemptId: attempt.id,
      orderNumber: attempt.orderNumber,
      amountCents: Math.round(Number(attempt.amount) * 100),
      currency: attempt.currency,
      customerPhone: attempt.customerPhone,
      providerReference: attempt.providerReference,
      externalReference: attempt.externalReference,
      createdAt: attempt.createdAt,
      claim,
      mode: settings.verification.mode,
      evidence: await this.gatheredEvidence(attempt.id),
    };
    let outcome: VerificationOutcome;
    try {
      outcome = await adapter.verifyAttempt(input, ctx);
    } catch (error) {
      outcome = { status: 'error', by: 'verification', reason: error instanceof Error ? error.message.slice(0, 300) : 'The check failed.', retryable: true };
    }
    return await this.act(attempt, ctx.provider.id, event, claim, outcome, settings);
  }

  private minutesSince(d: Date) {
    return (Date.now() - d.getTime()) / 60000;
  }

  private async act(attempt: PaymentAttemptRow, providerId: string, event: ProviderEventRow | null, claim: InboundClaim | null, outcome: VerificationOutcome, settings: ReturnType<typeof engineSettings>): Promise<VerifyResult> {
    const stateOf = (s: Parameters<ProviderEventService['setState']>[1], extra: Parameters<ProviderEventService['setState']>[2] = {}) => (event ? this.events.setState(event.id, s, extra) : Promise.resolve());
    switch (outcome.status) {
      case 'confirmed': {
        const reference = outcome.platformReference ?? claim?.platformReference ?? attempt.providerReference ?? attempt.id;
        const { row, created, amountDiffers } = await this.txs.claim({
          companyId: (await this.contexts.forProvider(providerId)).companyId,
          providerId,
          kind: 'gateway',
          platformReference: reference,
          amount: (Math.round(Number(attempt.amount) * 100) / 100).toFixed(2),
          currency: attempt.currency,
          payerMasked: claim?.payerMasked ?? null,
          payerHash: claim?.payerFingerprint ?? null,
          occurredAt: claim?.occurredAt ?? null,
        });
        if (amountDiffers) {
          await stateOf('mismatch', { failureCode: 'REFERENCE_REUSED', failureReason: `Reference ${reference} was already recorded for a different amount.` });
          return { outcome: 'mismatch', reason: 'The platform reference was already used for a different amount.' };
        }
        // The same platform transaction can settle one payment only.
        if (!created && row.consumedAt && row.consumedId !== attempt.id) {
          await stateOf('mismatch', { failureCode: 'REFERENCE_ALREADY_USED', failureReason: `Reference ${reference} already paid for something else.`, platformReference: reference });
          return { outcome: 'mismatch', reason: 'The platform reference was already counted for another payment.' };
        }
        await this.txs.addEvidence(row.id, outcome.evidence, outcome.by);
        await this.txs.setState(row.id, 'verified', { verifiedBy: outcome.by });
        await stateOf('verified', { platformReference: reference, amount: `${(outcome.amountCents ?? 0) / 100  }` });
        const done = await this.settler.succeed(attempt.id, { reference, verifiedBy: outcome.by, transactionId: row.id });
        if (done.settled) await this.txs.consume(row.id, 'payment_attempt', attempt.id);
        await stateOf('consumed', { platformReference: reference });
        return { outcome: 'confirmed' };
      }
      case 'failed': {
        await stateOf('verified', { failureCode: outcome.code, failureReason: outcome.reason });
        await this.settler.fail(attempt.id, { reason: outcome.reason, code: outcome.code });
        return { outcome: 'failed', reason: outcome.reason };
      }
      case 'mismatch': {
        await stateOf('mismatch', { failureCode: outcome.code, failureReason: outcome.reason });
        return { outcome: 'mismatch', reason: outcome.reason };
      }
      case 'pending': {
        if ((outcome.evidence as { needs?: string }).needs === 'transaction_status' && this.checks) {
          const evidence = outcome.evidence as { receipt?: string };
          if (has(evidence.receipt)) await this.checks.checkTransaction({ providerId, attemptId: attempt.id, receipt: evidence.receipt, shortcode: null });
        }
        return await this.again(attempt, event, settings, outcome.reason, 'pending');
      }
      case 'error': {
        if (!outcome.retryable) {
          await stateOf('unverified', { failureCode: 'CANNOT_VERIFY', failureReason: outcome.reason });
          return { outcome: 'error', reason: outcome.reason };
        }
        return await this.again(attempt, event, settings, outcome.reason, 'error');
      }
      case 'unavailable':
        await stateOf('unverified', { failureCode: 'NO_VERIFICATION', failureReason: outcome.reason });
        return { outcome: 'unavailable', reason: outcome.reason };
    }
  }

  /** Not decided yet: ask again later, for as long as the window allows. After that it is left in doubt for a person. */
  private async again(attempt: PaymentAttemptRow, event: ProviderEventRow | null, settings: ReturnType<typeof engineSettings>, reason: string, kind: 'pending' | 'error'): Promise<VerifyResult> {
    const age = this.minutesSince(attempt.createdAt);
    if (age >= settings.verification.windowMinutes) {
      const why = `Still not confirmed after ${Math.round(age)} minutes (${reason}). It needs a person: check it with the platform and confirm or fail it.`;
      if (event) await this.events.setState(event.id, 'unverified', { failureCode: 'IN_DOUBT', failureReason: why });
      return { outcome: kind === 'error' ? 'error' : 'pending', reason: why };
    }
    await this.jobs.verifyAttempt(attempt.id, delayForAge(settings.verification, age * 60));
    return { outcome: kind === 'error' ? 'error' : 'pending', reason };
  }
}
