import { and, desc, eq, inArray, ne } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { paymentAttempts, paymentProviderConfigs, providerTransactions, type BranchRow, type PaymentAttemptRow } from '@/server/db/drizzle/schema';
import { OrderStages } from '@/server/domains/orders/stages';
import { amountDue } from '@/server/domains/orders/amount-due';
import { CLAIM_WORDS, CLAIMABLE_METHODS, canCompletePayment, canLookUpByCode, checkCode, isClaimableMethod, stageOfOutcome, type ClaimStage, type ClaimableMethod, type Payable } from '@/lib/payment-claim';
import { isUniqueViolation } from '@/server/domains/settings/errors';
import { newSecret } from './engine/redact';
import type { PaymentEngine } from './engine';
import type { PaymentService } from './service';
import { PAYMENT_PROVIDER_META } from './types';
import type { Order } from '@/types/index';

/** What a shopper is told about a code they gave. `done` is true when nothing more will change without the shopper doing something. */
export interface ClaimAnswer {
  stage: ClaimStage;
  message: string;
  done: boolean;
  /** Where to ask again for progress, while the provider is still being asked. */
  attemptId: string | null;
}

export interface PayOptions {
  payable: Payable;
  amountDue: number;
  currency: string;
  /** The ways to pay that this shop has switched on, for "I have already paid" and for "Pay again" alike. */
  methods: { code: ClaimableMethod; label: string; usesPhone: boolean; canLookUpByCode: boolean }[];
}

export interface ClaimDeps {
  db: DrizzleDb;
  payments: Pick<PaymentService, 'resolveCheckout' | 'listEnabledProviders'>;
  engine: () => Pick<PaymentEngine, 'daraja' | 'verification'>;
  orders: { getById(id: string): Promise<Order | null | undefined> };
  rateLimits: { hit(rule: 'payment_claim_order' | 'payment_claim_ip' | 'payment_refresh_order', subject: string): Promise<{ allowed: boolean; retryAfterSeconds: number }> };
  /** The branch payments are recorded against (the shop's default). */
  branch: () => Promise<BranchRow>;
}

const PHONE_METHODS: readonly ClaimableMethod[] = ['mpesa_daraja', 'kcb_buni'];

const answer = (stage: ClaimStage, done: boolean, attemptId: string | null = null): ClaimAnswer => ({ stage, message: CLAIM_WORDS[stage], done, attemptId });

/**
 * The shopper has paid and holds the provider's message with its code, but the shop never heard back. They give the way they paid and
 * the code; the shop asks the provider itself about that code, and only what the provider says counts. A payment that matches is counted
 * through the same engine as any other (so the order, the receipt and the ledger follow), one code settles one payment, and nothing here
 * ever changes what is on the order. A code that cannot be checked automatically is kept with the order for a person.
 */
export class PaymentClaims {
  constructor(private readonly deps: ClaimDeps) {}

  /** What the shopper can do about an order that is waiting for its payment, and with which ways to pay. */
  async options(order: Order): Promise<PayOptions> {
    const due = amountDue(order);
    const payable = canCompletePayment({ status: order.status, paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, amountDue: due });
    if (!payable.ok) return { payable, amountDue: due, currency: order.currency, methods: [] };
    const branch = await this.deps.branch();
    const enabled = await this.deps.payments.listEnabledProviders(branch);
    const methods = CLAIMABLE_METHODS.filter((code) => enabled.some((p) => p.providerCode === code)).map((code) => ({ code, label: PAYMENT_PROVIDER_META[code].label, usesPhone: PHONE_METHODS.includes(code), canLookUpByCode: canLookUpByCode(code) }));
    return { payable, amountDue: due, currency: order.currency, methods };
  }

  /** The shopper says they paid with this code. Never throws for anything the shopper did: the answer is data, in words. */
  async start(input: { order: Order; method: unknown; code: unknown; address: string }): Promise<ClaimAnswer | { stage: 'refused'; message: string }> {
    const { order } = input;
    const due = amountDue(order);
    const payable = canCompletePayment({ status: order.status, paymentStatus: order.paymentStatus, paymentMethod: order.paymentMethod, amountDue: due });
    if (!payable.ok) return { stage: 'refused', message: payable.reason };
    if (!isClaimableMethod(input.method)) return { stage: 'refused', message: 'Please choose how you paid.' };
    const method = input.method;
    const checked = checkCode(method, input.code);
    if (!checked.ok) return { stage: 'refused', message: checked.error };

    for (const [rule, subject] of [['payment_claim_order', order.id], ['payment_claim_ip', input.address]] as const) {
      const verdict = await this.deps.rateLimits.hit(rule, subject);
      if (!verdict.allowed) return answer('busy', true);
    }

    const branch = await this.deps.branch();
    const resolved = await this.deps.payments.resolveCheckout(branch, method);
    if (resolved?.provider.isEnabled !== true) return { stage: 'refused', message: 'That way of paying is not available for this shop. Choose another, or pay again.' };
    const provider = resolved.provider;

    // The same order asking again with the same code is the same question; a code that already settled or is held for another order is not ours to say anything about.
    const existing = await this.deps.db.select().from(paymentAttempts).where(and(eq(paymentAttempts.providerCode, method), eq(paymentAttempts.claimedReceipt, checked.code), eq(paymentAttempts.source, 'customer_claim'), ne(paymentAttempts.status, 'cancelled')));
    const mine = existing.find((a) => a.orderId === order.id && a.status !== 'failed');
    if (mine !== undefined) return await this.progress(mine);
    if (existing.some((a) => a.status !== 'failed')) return answer('used', true);
    const settledBefore = await this.deps.db.select({ id: providerTransactions.id }).from(providerTransactions).innerJoin(paymentProviderConfigs, eq(paymentProviderConfigs.id, providerTransactions.providerId)).where(and(eq(paymentProviderConfigs.providerCode, method), eq(providerTransactions.platformReference, checked.code))).limit(1);
    if (settledBefore.length > 0) return answer('used', true);

    let inserted: PaymentAttemptRow[];
    try {
      inserted = await this.deps.db
        .insert(paymentAttempts)
        .values({
          branchId: branch.id,
          providerConfigId: provider.id,
          providerCode: method,
          orderId: order.id,
          orderNumber: order.orderNumber,
          amount: due.toFixed(2),
          currency: order.currency,
          status: 'pending',
          callbackToken: newSecret(),
          callbackUrl: '',
          customerPhone: order.paymentPhone ?? order.customerPhone,
          customerEmail: order.customerEmail,
          source: 'customer_claim',
          claimedReceipt: checked.code,
          requestPayload: { claimedCode: checked.code, amount: due, currency: order.currency },
        })
        .returning();
    } catch (error) {
      // Two people sent the same code at the same moment: the database let one through.
      if (isUniqueViolation(error)) return answer('used', true);
      throw error;
    }
    const attempt = inserted.at(0);
    if (attempt === undefined) return { stage: 'refused', message: 'We could not record your payment details just now. Please try again.' };

    await OrderStages.move(this.deps.db, order.id, 'payment_pending_verification', 'succeeded', {
      source: 'shop',
      ref: { type: 'payment_attempt', id: attempt.id },
      message: 'The customer says they already paid and gave the provider’s transaction code.',
      detail: { provider: method, kind: 'customer_claim', code: checked.code },
    });

    if (!canLookUpByCode(method)) return await this.keepForPerson(order, attempt, 'saved');

    try {
      await this.deps.engine().daraja.start({
        providerId: provider.id,
        operation: 'transaction_status',
        input: { transactionId: checked.code },
        idempotencyKey: `claim:${attempt.id}`,
        subject: { type: 'payment_attempt', id: attempt.id },
        origin: { kind: 'customer_claim', orderId: order.id },
      });
    } catch (error) {
      // The platform could not be asked (the operator's sign-in is not saved, or the check is switched off): said in words, kept for a person.
      console.warn('[claims] the platform could not be asked about a code', order.orderNumber, error instanceof Error ? error.message : error);
      return await this.keepForPerson(order, attempt, 'unavailable');
    }
    return await this.progress(attempt);
  }

  /** Where a claim has got to. Asks the platform's answer to be read again, so a shopper waiting on the page sees it the moment it is there. */
  async status(input: { orderId: string; attemptId: string }): Promise<ClaimAnswer | null> {
    const [attempt] = await this.deps.db.select().from(paymentAttempts).where(and(eq(paymentAttempts.id, input.attemptId), eq(paymentAttempts.orderId, input.orderId), eq(paymentAttempts.source, 'customer_claim')));
    return attempt === undefined ? null : await this.progress(attempt);
  }

  /**
   * Reads again the payments the shop itself started for this order and has not heard the end of (a prompt whose answer never arrived).
   * Often this alone puts it right, with no code. Returns whether the order is now paid.
   */
  async refresh(orderId: string): Promise<{ paid: boolean }> {
    const verdict = await this.deps.rateLimits.hit('payment_refresh_order', orderId);
    if (!verdict.allowed) return { paid: false };
    const open = await this.deps.db.select({ id: paymentAttempts.id }).from(paymentAttempts).where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.source, 'checkout'), inArray(paymentAttempts.status, ['initiated', 'pending', 'awaiting_redirect']))).orderBy(desc(paymentAttempts.createdAt)).limit(5);
    for (const { id } of open) {
      try {
        await this.deps.engine().verification.verifyAttempt(id);
      } catch (error) {
        console.warn('[claims] could not re-read a payment', id, error instanceof Error ? error.message : error);
      }
    }
    const [paid] = await this.deps.db.select({ id: paymentAttempts.id }).from(paymentAttempts).where(and(eq(paymentAttempts.orderId, orderId), eq(paymentAttempts.status, 'successful'))).limit(1);
    return { paid: paid !== undefined };
  }

  /** A code kept for a person: the claim stays open, with the order's own payments read again meanwhile, and the shopper is told so. */
  private async keepForPerson(order: Order, attempt: PaymentAttemptRow, stage: 'saved' | 'unavailable'): Promise<ClaimAnswer> {
    await this.refresh(order.id).catch(() => undefined);
    const reason = stage === 'saved' ? 'This provider has no way to look a payment up by its code, so the code was kept for a person to confirm.' : 'The provider could not be asked just now, so the code was kept for a person to confirm.';
    await this.deps.db.update(paymentAttempts).set({ errorMessage: reason, responsePayload: { claim: { code: 'KEPT_FOR_PERSON', reason, held: true } }, updatedAt: new Date() }).where(eq(paymentAttempts.id, attempt.id));
    await OrderStages.move(this.deps.db, order.id, 'payment_pending_verification', 'failed', {
      source: 'shop',
      ref: { type: 'payment_attempt', id: attempt.id },
      reasonCode: stage === 'saved' ? 'claim_no_lookup' : 'claim_not_checkable',
      message: reason,
      detail: { provider: attempt.providerCode, kind: 'customer_claim', code: attempt.claimedReceipt, heldForPerson: true },
    });
    return answer(stage, true, attempt.id);
  }

  /** Asks for the platform's answer to be read and turns where the claim is into words. */
  private async progress(attempt: PaymentAttemptRow): Promise<ClaimAnswer> {
    if (attempt.status === 'successful') return answer('confirmed', true, attempt.id);
    const claim = (attempt.responsePayload as { claim?: { code?: string | null; held?: boolean } } | null)?.claim;
    if (attempt.status === 'failed') return answer(stageOfOutcome(claim?.code), true, attempt.id);
    if (claim?.held === true) return answer(claim.code === 'KEPT_FOR_PERSON' ? 'saved' : stageOfOutcome(claim.code), true, attempt.id);
    let result: Awaited<ReturnType<ReturnType<ClaimDeps['engine']>['verification']['verifyAttempt']>>;
    try {
      result = await this.deps.engine().verification.verifyAttempt(attempt.id);
    } catch (error) {
      console.warn('[claims] could not read the platform’s answer', attempt.id, error instanceof Error ? error.message : error);
      return answer('checking', false, attempt.id);
    }
    if (result.outcome === 'confirmed' || result.outcome === 'already_final') return await this.settledAnswer(attempt.id);
    if (result.outcome === 'failed' || result.outcome === 'mismatch') return answer(stageOfOutcome(result.code), true, attempt.id);
    if (result.outcome === 'unavailable') return answer('unavailable', true, attempt.id);
    return answer('checking', false, attempt.id);
  }

  private async settledAnswer(attemptId: string): Promise<ClaimAnswer> {
    const [row] = await this.deps.db.select({ status: paymentAttempts.status }).from(paymentAttempts).where(eq(paymentAttempts.id, attemptId));
    return row?.status === 'successful' ? answer('confirmed', true, attemptId) : answer('checking', false, attemptId);
  }
}
