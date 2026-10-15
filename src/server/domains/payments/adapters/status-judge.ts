import type { VerificationOutcome, VerifyAttemptInput } from '../engine/types';
import { toCentsLoose } from '../daraja/security';

import { has, orElse, readText } from '@/lib/values';

/** What a platform's own record of a payment says, reduced to what the decision needs. */
export interface PlatformAnswer {
  state: 'paid' | 'failed' | 'pending';
  /** The platform's receipt or transaction number, when it gave one. */
  reference: string | null;
  amount: unknown;
  currency: string | null;
  /** Our reference as the platform holds it (the order number, or the id we sent). */
  orderReference: string | null;
  reason: string;
  /** The parts of the answer that are safe to keep as evidence. */
  evidence: Record<string, unknown>;
}

/**
 * Decides what a platform's answer means for the payment we started. Paid only counts when the amount,
 * currency and our own reference all agree with what we asked for; anything else is a mismatch.
 */
export function judgeAnswer(by: string, answer: PlatformAnswer, input: VerifyAttemptInput, ours: string[]): VerificationOutcome {
  const { evidence } = answer;
  if (answer.state === 'failed') return { status: 'failed', by, code: 'PLATFORM_DECLINED', reason: answer.reason, evidence };
  if (answer.state === 'pending') return { status: 'pending', by, reason: answer.reason, evidence };
  if (has(answer.orderReference) && !ours.includes(answer.orderReference)) {
    return { status: 'mismatch', by, code: 'REFERENCE_MISMATCH', reason: `The platform says this payment belongs to ${answer.orderReference}, not ${input.orderNumber}.`, evidence };
  }
  const cents = toCentsLoose(answer.amount);
  if (cents === null || cents !== input.amountCents) {
    return { status: 'mismatch', by, code: 'AMOUNT_MISMATCH', reason: `The platform says ${orElse(readText(answer.amount), 'no amount')} was paid, but ${(input.amountCents / 100).toFixed(2)} was asked for.`, evidence };
  }
  if (has(answer.currency) && answer.currency.toUpperCase() !== input.currency.toUpperCase()) {
    return { status: 'mismatch', by, code: 'CURRENCY_MISMATCH', reason: `The platform says the currency is ${answer.currency}, not ${input.currency}.`, evidence };
  }
  return { status: 'confirmed', by, platformReference: answer.reference, amountCents: cents, evidence };
}

/** The ways a platform call can leave us without an answer, as outcomes. */
export function unusableAnswer(by: string, label: string, res: { reached: boolean; status: number; networkError?: string | null; text: string }): VerificationOutcome | null {
  if (!res.reached || res.status >= 500 || res.status === 429) {
    return { status: 'error', by, reason: res.networkError ?? `${label} answered ${String(res.status)}.`, retryable: true };
  }
  if (res.status >= 400) {
    return { status: 'error', by, reason: `${label}'s answer could not be used (${String(res.status)}): ${res.text.slice(0, 200)}`, retryable: res.status !== 400 && res.status !== 404 };
  }
  return null;
}

/** Paid, failed, or (neither yet) pending. */
export const stateOf = (paid: boolean, failed: boolean): PlatformAnswer['state'] => {
  if (paid) return 'paid';
  return failed ? 'failed' : 'pending';
};
