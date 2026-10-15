import type { InboundClaim, PlatformContext, VerificationOutcome, VerifyAttemptInput } from '../engine/types';
import { DarajaClient, darajaFailure } from './client';
import { parseAsyncResult } from './parsers';
import { phoneFingerprint } from '../engine/redact';
import { darajaTimestamp, looksLikeReceipt, stkPassword } from './security';

import { has } from '@/lib/has';

/**
 * Deciding whether a payment is real. A callback is only a claim. These checks compare the claim
 * with what we asked for, then ask Safaricom itself; only Safaricom's own answer, for the very request
 * we made, can confirm a payment. Anything that disagrees is refused, with the reason.
 */

/** What the callback claims must be consistent with the request we made. Returns the first contradiction, or null. */
export function crossCheckClaim(input: VerifyAttemptInput): { code: string; reason: string } | null {
  const c = input.claim;
  if (!c) return null;
  const ids = c.requestIds;
  if (has(input.providerReference) && has(ids.checkoutRequestId) && ids.checkoutRequestId !== input.providerReference) {
    return { code: 'CHECKOUT_ID_MISMATCH', reason: `The callback names checkout ${ids.checkoutRequestId}, but this payment was requested as ${input.providerReference}.` };
  }
  if (has(input.externalReference) && has(ids.merchantRequestId) && ids.merchantRequestId !== input.externalReference) {
    return { code: 'MERCHANT_ID_MISMATCH', reason: `The callback names merchant request ${ids.merchantRequestId}, but this payment was requested as ${input.externalReference}.` };
  }
  if (c.claimsSuccess === true) {
    if (c.amountCents !== null && c.amountCents !== input.amountCents) {
      return { code: 'AMOUNT_MISMATCH', reason: `The callback says ${(c.amountCents / 100).toFixed(2)} was paid, but ${(input.amountCents / 100).toFixed(2)} was asked for.` };
    }
    if (has(c.payerFingerprint) && has(input.customerPhone) && c.payerFingerprint !== phoneFingerprint(input.customerPhone)) {
      return { code: 'PAYER_MISMATCH', reason: 'The callback says the payment came from a different phone number than the one the prompt was sent to.' };
    }
    if (has(c.platformReference) && !looksLikeReceipt(c.platformReference)) {
      return { code: 'RECEIPT_FORMAT', reason: `"${c.platformReference}" does not look like an M-Pesa receipt number.` };
    }
  }
  return null;
}

export async function verifyStk(input: VerifyAttemptInput, ctx: PlatformContext): Promise<VerificationOutcome> {
  const contradiction = crossCheckClaim(input);
  if (contradiction) return { status: 'mismatch', by: 'cross_check', code: contradiction.code, reason: contradiction.reason, evidence: { claim: input.claim ? { requestIds: input.claim.requestIds, amountCents: input.claim.amountCents } : null } };
  if (!has(input.providerReference)) return { status: 'error', by: 'stk_query', reason: 'This payment has no checkout request id to ask about.', retryable: false };
  const client = new DarajaClient(ctx);
  const creds = client.credentials;
  if (!has(creds.shortcode?.trim()) || !has(creds.passkey?.trim())) return { status: 'error', by: 'stk_query', reason: 'Checking a payment needs the business shortcode and passkey on the provider.', retryable: false };
  const ts = darajaTimestamp(ctx.now());
  const res = await client.request('stk_query', 'POST', '/mpesa/stkpushquery/v1/query', {
    BusinessShortCode: creds.shortcode.trim(),
    Password: stkPassword(creds.shortcode.trim(), creds.passkey.trim(), ts),
    Timestamp: ts,
    CheckoutRequestID: input.providerReference,
  });
  const failure = darajaFailure(res);
  const j = res.json ?? {};
  if (failure) {
    // Safaricom answers "being processed" with an error body while the customer is still deciding.
    if (/being processed|still processing|in progress/i.test(failure.message)) return { status: 'pending', by: 'stk_query', reason: failure.message, evidence: { code: failure.code } };
    return { status: 'error', by: 'stk_query', reason: `${failure.code}: ${failure.message}`, retryable: failure.retryable || failure.tokenRejected };
  }
  const responseCode = String(j.ResponseCode ?? '');
  const resultCode = j.ResultCode === undefined ? null : String(j.ResultCode);
  const evidence = { stkQuery: { responseCode, resultCode, resultDesc: j.ResultDesc ?? null, checkoutRequestId: j.CheckoutRequestID ?? null, merchantRequestId: j.MerchantRequestID ?? null } };
  if (responseCode !== '0' || resultCode === null) {
    return { status: 'error', by: 'stk_query', reason: `Safaricom's answer to the check was not usable (ResponseCode ${responseCode || 'none'}).`, retryable: true };
  }
  // The answer must be about the request we asked about.
  if (j.CheckoutRequestID && String(j.CheckoutRequestID) !== input.providerReference) {
    return { status: 'mismatch', by: 'stk_query', code: 'QUERY_ID_MISMATCH', reason: 'Safaricom answered about a different checkout request than the one we asked about.', evidence };
  }
  if (resultCode === '0') {
    return { status: 'confirmed', by: 'stk_query', platformReference: input.claim?.platformReference ?? null, amountCents: input.amountCents, evidence: { ...evidence, claimContradicted: input.claim?.claimsSuccess === false } };
  }
  return { status: 'failed', by: 'stk_query', code: resultCode, reason: String(j.ResultDesc ?? `ResultCode ${resultCode}`), evidence: { ...evidence, claimContradicted: input.claim?.claimsSuccess === true } };
}

export interface StatusAnswer {
  ok: boolean;
  receipt: string | null;
  amountCents: number | null;
  status: string;
  creditParty: string | null;
  resultCode: string;
  resultDesc: string | null;
}

/** Reads a Transaction Status result into what it says about the transaction. */
export function readStatusAnswer(result: Record<string, unknown>): StatusAnswer | null {
  const parsed = parseAsyncResult({ Result: { ResultCode: (result as { resultCode?: unknown }).resultCode, ResultDesc: (result as { resultDesc?: unknown }).resultDesc, ResultParameters: { ResultParameter: Object.entries((result.params ?? {}) as Record<string, string>).map(([Key, Value]) => ({ Key, Value })) } } });
  if (!parsed) return null;
  const p = parsed.params;
  const amount = has(p.Amount) ? Math.round(Number(String(p.Amount).replace(/,/g, '')) * 100) : null;
  return {
    ok: parsed.resultCode === '0' && /^completed$/i.test(p.TransactionStatus ?? 'completed'),
    receipt: p.ReceiptNo ?? null,
    amountCents: amount !== null && Number.isFinite(amount) ? amount : null,
    status: p.TransactionStatus ?? '',
    creditParty: p.CreditPartyName ?? null,
    resultCode: parsed.resultCode,
    resultDesc: parsed.resultDesc,
  };
}

/** Does a Transaction Status answer agree with the payment we are confirming? */
export function statusAgrees(answer: StatusAnswer, expect: { receipt: string | null; amountCents: number; shortcode: string | null }): { ok: true } | { ok: false; code: string; reason: string } {
  if (!answer.ok) return { ok: false, code: 'STATUS_NOT_COMPLETED', reason: `The transaction status is "${answer.status || 'unknown'}" (${answer.resultDesc ?? answer.resultCode}).` };
  if (has(expect.receipt) && has(answer.receipt) && answer.receipt !== expect.receipt) return { ok: false, code: 'STATUS_RECEIPT_MISMATCH', reason: `The status answer is for ${answer.receipt}, not ${expect.receipt}.` };
  if (answer.amountCents !== null && answer.amountCents !== expect.amountCents) {
    return { ok: false, code: 'STATUS_AMOUNT_MISMATCH', reason: `The platform says ${(answer.amountCents / 100).toFixed(2)} was moved, not ${(expect.amountCents / 100).toFixed(2)}.` };
  }
  if (has(expect.shortcode) && has(answer.creditParty) && !answer.creditParty.includes(expect.shortcode)) {
    return { ok: false, code: 'STATUS_RECEIVER_MISMATCH', reason: `The platform says the money went to "${answer.creditParty}", not to shortcode ${expect.shortcode}.` };
  }
  return { ok: true };
}

export type { InboundClaim };
