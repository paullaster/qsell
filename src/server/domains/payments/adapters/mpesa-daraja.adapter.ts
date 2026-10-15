import { probeConnection, type CallbackInput, type CallbackResult, type ConnectionTestResult, type InitiatePaymentInput, type InitiatePaymentResult, type PaymentPort } from '../port';
import { asDarajaCredentials, type MpesaDarajaCredentials } from '../types';
import { extractPaymentReference } from '../payment-reference';
import { DarajaClient, standaloneContext } from '../daraja/client';
import { parseStkCallback } from '../daraja/parsers';
import { statusAgrees, readStatusAnswer, verifyStk } from '../daraja/verify';
import type { InboundClaim, PlatformContext, VerificationOutcome, VerifyAttemptInput } from '../engine/types';

import { has } from '@/lib/has';

/**
 * M-Pesa (Daraja) as a place customers pay. Starting a payment goes through the operations engine
 * (it is written down, logged and checked); this adapter reads callbacks and, above all, asks Safaricom
 * whether a payment is real before anything may count it.
 */
export class MpesaDarajaAdapter implements PaymentPort {
  readonly code = 'mpesa_daraja' as const;
  readonly capabilities = ['collect', 'status_query', 'register_urls', 'balance', 'statement'] as const;

  async testConnection(credentials: Record<string, unknown>, _settings: Record<string, unknown>, apiBaseUrl: string): Promise<ConnectionTestResult> {
    const creds = asDarajaCredentials(credentials);
    return await probeConnection('M-Pesa (Daraja)', async () => {
      if (!has(creds.consumerKey) || !has(creds.consumerSecret)) throw new Error('The consumer key and secret are not saved yet.');
      // Always ask Safaricom afresh: a cached token would say nothing about these credentials.
      const client = new DarajaClient(standaloneContext(credentials, apiBaseUrl));
      client.forgetToken();
      const got = await client.token(true);
      if ('error' in got) throw new Error(got.error.message);
    });
  }

  async initiate(_input: InitiatePaymentInput): Promise<InitiatePaymentResult> {
    // The engine starts M-Pesa Express (PaymentService → DarajaOperations) so the request is recorded before it is sent.
    return { status: 'failed', errorMessage: 'M-Pesa Express is started through the payment engine.' };
  }

  parseCallback(body: unknown): InboundClaim | null {
    return parseStkCallback(body);
  }

  async verifyAttempt(input: VerifyAttemptInput, ctx: PlatformContext): Promise<VerificationOutcome> {
    const stk = await verifyStk(input, ctx);
    if (stk.status !== 'confirmed' || input.mode !== 'strict') return stk;
    // Strict: Safaricom's own record of the transaction (by its receipt) must also agree.
    const receipt = stk.platformReference;
    if (!has(receipt)) return { status: 'error', by: 'transaction_status', reason: 'The callback never gave a receipt number, so the strict check is not possible. Confirm by hand, or use the standard check.', retryable: false };
    const ev = input.evidence.find((e) => e.by === 'transaction_status');
    if (!ev) return { status: 'pending', by: 'transaction_status', reason: 'Waiting for Safaricom\'s transaction status for this receipt.', evidence: { ...stk.evidence, needs: 'transaction_status', receipt } };
    const answer = readStatusAnswer((ev.result ?? {}) as Record<string, unknown>);
    if (!answer) return { status: 'error', by: 'transaction_status', reason: 'The transaction status answer could not be read.', retryable: false };
    const agreed = statusAgrees(answer, { receipt, amountCents: input.amountCents, shortcode: asDarajaCredentials(ctx.credentials).shortcode ?? null });
    if (!agreed.ok) return { status: 'mismatch', by: 'transaction_status', code: agreed.code, reason: agreed.reason, evidence: { ...stk.evidence, transactionStatus: ev.result } };
    return { ...stk, by: 'stk_query+transaction_status', platformReference: receipt, evidence: { ...stk.evidence, transactionStatus: ev.result } };
  }

  /** Kept for the manual classification screen: what the body says, without any confirmation. */
  async handleCallback(input: CallbackInput): Promise<CallbackResult> {
    const claim = parseStkCallback(input.body);
    if (!claim) return { ok: false, status: 'failed', errorMessage: 'Invalid Daraja callback payload' };
    const base = { providerReference: claim.requestIds.checkoutRequestId, externalReference: claim.requestIds.merchantRequestId, raw: input.body as Record<string, unknown> };
    if (claim.claimsSuccess === true) return { ok: true, status: 'successful', receiptNumber: extractPaymentReference('mpesa_daraja', input.body) ?? undefined, ...base };
    return { ok: true, status: 'failed', errorMessage: claim.failureReason ?? `ResultCode ${claim.failureCode}`, ...base };
  }
}
