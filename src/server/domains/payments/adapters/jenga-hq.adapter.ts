import { createSign } from 'node:crypto';
import {
  probeConnection,
  type CallbackInput,
  type CallbackResult,
  type InitiatePaymentInput,
  type InitiatePaymentResult,
  type ConnectionTestResult,
  type PaymentPort,
} from '../port';
import { asJengaCredentials, type JengaHqCredentials } from '../types';
import { extractPaymentReference } from '../payment-reference';
import type { InboundClaim, PlatformContext, VerificationOutcome, VerifyAttemptInput } from '../engine/types';
import { judgeAnswer, stateOf, unusableAnswer, type PlatformAnswer } from './status-judge';
import { callFailure, runPull } from './statement-pull-runner';
import { jengaCursor, jengaFullStatementPlain, jengaLines, readJengaPage, type StatementPullRequest, type StatementPullResult } from '../statement-pull';

import { toCentsLoose } from '../daraja/security';

import { asRecord, emptyToNull, firstFilled, has, orElse, readText } from '@/lib/values';

/**
 * Jenga HQ receive-money / checkout adapter.
 * Signature formula follows Jenga docs (SHA-256 RSA over concatenated fields).
 */
function jengaReason(paid: boolean, failed: boolean, state: string, j: Record<string, unknown>): string {
  if (paid) return 'Paid.';
  if (failed) return readText(j.message, j.responseMessage, 'Jenga reports the payment did not go through.');
  return `Jenga reports "${state}".`;
}

export class JengaHqAdapter implements PaymentPort {
  readonly code = 'jenga_hq' as const;
  readonly capabilities = ['collect', 'status_query', 'statement'] as const;

  async testConnection(
    credentials: Record<string, unknown>,
    _settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<ConnectionTestResult> {
    const creds = asJengaCredentials(credentials);
    return await probeConnection('Jenga', async () => {
      if (!has(creds.merchantCode) || !has(creds.consumerSecret) || !has(creds.apiKey)) throw new Error('The merchant code, consumer secret and API key are not all saved yet.');
      await this.authenticate(apiBaseUrl, creds);
    });
  }


  private sign(plainText: string, privateKeyPem: string): string {
    const signer = createSign('RSA-SHA256');
    signer.update(plainText);
    signer.end();
    return signer.sign(privateKeyPem, 'base64');
  }

  private async authenticate(apiBaseUrl: string, creds: JengaHqCredentials): Promise<string> {
    const res = await fetch(`${apiBaseUrl}/authentication/api/v3/authenticate/merchant`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Api-Key': creds.apiKey,
      },
      body: JSON.stringify({
        merchantCode: creds.merchantCode,
        consumerSecret: creds.consumerSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Jenga auth failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { accessToken?: string; token?: string };
    const token = orElse(data.accessToken, data.token);
    if (!has(token)) throw new Error('Jenga auth missing access token');
    return token;
  }

  async initiate(
    input: InitiatePaymentInput,
    credentials: Record<string, unknown>,
    settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<InitiatePaymentResult> {
    const creds = asJengaCredentials(credentials);
    if (!has(creds.merchantCode) || !has(creds.consumerSecret) || !has(creds.apiKey) || !has(creds.privateKeyPem)) {
      return {
        status: 'failed',
        errorMessage: 'Jenga HQ credentials are incomplete. Configure them in admin.',
      };
    }

    try {
      const token = await this.authenticate(apiBaseUrl, creds);
      const countryCode = readText(settings.countryCode, 'KE');
      const ref = input.orderNumber.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
      // Concat order per Jenga receive-money / checkout docs — amount + currency + reference + etc.
      const plain = `${Math.round(input.amount)}${input.currency}${ref}${creds.merchantCode}`;
      const signature = this.sign(plain, creds.privateKeyPem);

      const path =
        typeof settings.initiatePath === 'string'
          ? settings.initiatePath
          : '/v3-apis/transaction-api/v3.0/payments';

      const body = {
        merchant: { countryCode, merchantCode: creds.merchantCode },
        payment: {
          ref,
          amount: String(input.amount),
          currency: input.currency,
          description: orElse(input.description, `Order ${input.orderNumber}`),
          callbackUrl: input.callbackUrl,
        },
        customer: {
          name: input.customerName,
          ...(input.customerEmail.trim() === '' ? {} : { email: input.customerEmail }),
          mobileNumber: input.customerPhone,
        },
      };

      const res = await fetch(`${apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          signature,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return {
          status: 'failed',
          errorMessage: readText(raw.message, raw.responseMessage, `Jenga failed (${res.status})`),
          rawResponse: raw,
        };
      }

      const redirect = firstFilled(typeof raw.redirectUrl === 'string' ? raw.redirectUrl : null, typeof raw.paymentUrl === 'string' ? raw.paymentUrl : null) ?? undefined;

      return {
        status: has(redirect) ? 'awaiting_redirect' : 'pending',
        providerReference: readText(raw.transactionId, raw.transactionReference, ref),
        externalReference: readText(raw.reference, ref),
        redirectUrl: redirect,
        rawResponse: raw,
      };
    } catch (err) {
      return {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Jenga initiate failed',
      };
    }
  }

  /** The reference Jenga was given for a payment: the order number without anything but letters and digits. */
  static referenceFor(orderNumber: string): string {
    return orderNumber.replace(/[^A-Za-z0-9]/g, '').slice(0, 20);
  }

  /** A callback only points at the payment; it is never believed. */
  parseCallback(body: unknown): InboundClaim | null {
    const b = asRecord(body);
    const reference = readText(b.reference, b.orderReference, b.transactionReference, b.transactionId, '');
    if (!has(reference)) return null;
    const status = readText(b.status, b.transactionStatus, b.state, '').toLowerCase();
    const succeeded = status.includes('success') || status.includes('completed') || status === '0';
    const failed = status.includes('fail') || status.includes('error');
    const cents = toCentsLoose(b.amount);
    return {
      kind: 'callback',
      claimsSuccess: succeeded || (failed ? false : null),
      platformReference: emptyToNull(readText(b.transactionId, b.transactionReference, '')),
      conversationId: null,
      originatorId: null,
      requestIds: { reference },
      amountCents: cents,
      currency: orElse(readText(b.currency), 'KES'),
      payerFingerprint: null,
      payerMasked: null,
      shortcode: null,
      accountReference: reference,
      occurredAt: null,
      failureCode: null,
      failureReason: failed ? readText(b.message, b.responseMessage, status) : null,
      extra: {},
    };
  }

  /** Jenga's own record of the payment, asked for by the reference we gave it: state, amount, currency, reference. */
  async verifyAttempt(input: VerifyAttemptInput, ctx: PlatformContext): Promise<VerificationOutcome> {
    const by = 'jenga_status';
    const creds = asJengaCredentials(ctx.credentials);
    if (!has(creds.merchantCode) || !has(creds.consumerSecret) || !has(creds.apiKey)) {
      return { status: 'error', by, reason: 'The Jenga credentials are incomplete, so the payment cannot be checked.', retryable: false };
    }
    const base = ctx.provider.apiBaseUrl.replace(/\/$/, '');
    const ref = JengaHqAdapter.referenceFor(input.orderNumber);
    const claimed = input.claim?.requestIds.reference;
    if (has(claimed) && claimed !== ref && claimed !== input.providerReference && claimed !== input.externalReference) {
      return { status: 'mismatch', by: 'cross_check', code: 'REFERENCE_MISMATCH', reason: `The notification names ${claimed}, but this payment is ${ref}.`, evidence: {} };
    }
    const auth = await ctx.call({ label: 'oauth', provider: 'jenga_hq', method: 'POST', url: `${base}/authentication/api/v3/authenticate/merchant`, headers: { 'Api-Key': creds.apiKey }, body: { merchantCode: creds.merchantCode, consumerSecret: creds.consumerSecret }, timeoutMs: 15000 });
    const token = readText(auth.json?.accessToken, auth.json?.token, '');
    if (!has(token)) return { status: 'error', by, reason: `Jenga did not give a token (${auth.reached ? String(auth.status) : (auth.networkError ?? 'no answer')}).`, retryable: true };
    const template = typeof ctx.settings.statusPath === 'string' ? ctx.settings.statusPath : '/v3-apis/transaction-api/v3.0/payments/{ref}';
    const res = await ctx.call({ label: 'get_transaction_status', provider: 'jenga_hq', method: 'GET', url: `${base}${template.replace('{ref}', encodeURIComponent(ref))}`, headers: { Authorization: `Bearer ${token}` }, timeoutMs: 20000 });
    const unusable = unusableAnswer(by, 'Jenga', res);
    if (unusable) return unusable;
    const j = asRecord(res.json?.data ?? res.json);
    const state = readText(j.status, j.transactionStatus, j.state, '').toLowerCase();
    if (!has(state)) return { status: 'error', by, reason: 'Jenga\'s answer had no payment status.', retryable: true };
    const paid = state.includes('success') || state.includes('completed') || state === '0';
    const failed = state.includes('fail') || state.includes('error') || state.includes('declin') || state.includes('cancel') || state.includes('revers');
    const answer: PlatformAnswer = {
      state: stateOf(paid, failed),
      reference: emptyToNull(readText(j.transactionId, j.transactionReference, j.bankReference, '')),
      amount: j.amount,
      currency: emptyToNull(readText(j.currency, '')),
      orderReference: emptyToNull(readText(j.reference, j.orderReference, '')),
      reason: jengaReason(paid, failed, state, j),
      evidence: { jenga: { status: state, reference: j.reference ?? null, transactionId: j.transactionId ?? null, amount: j.amount ?? null, currency: j.currency ?? null } },
    };
    return judgeAnswer(by, answer, input, [ref, input.orderNumber]);
  }

  /**
   * The account's full statement from Jenga (POST .../accounts/fullStatement). The call is signed over the account number, the country
   * and the last day; a page that is full is followed by asking for the one after its last transaction. The path and the page size can
   * be changed in the provider settings (`statementPath`, `statementPageSize`) if Jenga moves them.
   */
  async pullStatement(request: StatementPullRequest, ctx: PlatformContext): Promise<StatementPullResult> {
    const creds = asJengaCredentials(ctx.credentials);
    if (!has(creds.merchantCode) || !has(creds.consumerSecret) || !has(creds.apiKey)) return { ok: false, error: 'The Jenga merchant code, consumer secret and API key are not all saved yet.', retryable: false };
    if (!has(creds.privateKeyPem)) return { ok: false, error: 'Jenga signs every statement request: the private key is not saved with this provider yet.', retryable: false };
    const base = ctx.provider.apiBaseUrl.replace(/\/$/, '');
    const auth = await ctx.call({ label: 'oauth', provider: 'jenga_hq', method: 'POST', url: `${base}/authentication/api/v3/authenticate/merchant`, headers: { 'Api-Key': creds.apiKey }, body: { merchantCode: creds.merchantCode, consumerSecret: creds.consumerSecret }, timeoutMs: 15000 });
    const failed = callFailure('Jenga', auth);
    if (failed !== null) return { ok: false, ...failed };
    const token = readText(auth.json?.accessToken, auth.json?.token, '');
    if (!has(token)) return { ok: false, error: 'Jenga did not give a token. Check the merchant code, consumer secret and API key.', retryable: false };
    let signature: string;
    try {
      signature = this.sign(jengaFullStatementPlain(request), creds.privateKeyPem);
    } catch {
      return { ok: false, error: 'The private key saved with this provider could not be used to sign. Save it again as a PEM key.', retryable: false };
    }
    const path = typeof ctx.settings.statementPath === 'string' ? ctx.settings.statementPath : '/v3-apis/account-api/v3.0/accounts/fullStatement';
    const size = typeof ctx.settings.statementPageSize === 'number' && ctx.settings.statementPageSize >= 1 && ctx.settings.statementPageSize <= 500 ? Math.floor(ctx.settings.statementPageSize) : 100;
    return await runPull(
      ctx,
      {
        provider: 'Jenga',
        label: 'full_statement',
        request: (cursor) => ({
          method: 'POST',
          url: `${base}${path}`,
          headers: { Authorization: `Bearer ${token}`, signature, 'Content-Type': 'application/json' },
          body: { countryCode: request.countryCode, accountNumber: request.accountNumber, fromDate: request.fromDate, toDate: request.toDate, limit: size, ...(cursor ?? {}) },
        }),
        read: (json) => {
          const page = readJengaPage(json);
          if (page.problem !== null) return { lines: [], count: 0, cursor: null, problem: page.problem };
          const read = jengaLines(page.transactions);
          const last = page.transactions.at(-1);
          return { lines: read.lines, count: page.transactions.length, cursor: last === undefined ? null : jengaCursor(last), problem: read.problem };
        },
      },
      size,
    );
  }

  handleCallback(input: CallbackInput): Promise<CallbackResult> {
    return Promise.resolve(this.readCallback(input));
  }

  private readCallback(input: CallbackInput): CallbackResult {
    const body = asRecord(input.body);
    const status = readText(body.status, body.transactionStatus, body.state, '').toLowerCase();
    if (status.includes('success') || status.includes('completed') || status === '0') {
      return {
        ok: true,
        status: 'successful',
        providerReference: readText(body.transactionId, body.transactionReference, ''),
        receiptNumber: extractPaymentReference('jenga_hq', body) ?? undefined,
        raw: body,
      };
    }
    if (status.includes('fail') || status.includes('error')) {
      return {
        ok: true,
        status: 'failed',
        errorMessage: readText(body.message, body.responseMessage, status),
        raw: body,
      };
    }
    return { ok: true, status: 'pending', raw: body };
  }
}
