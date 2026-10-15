import {
  probeConnection,
  type CallbackInput,
  type CallbackResult,
  type InitiatePaymentInput,
  type InitiatePaymentResult,
  type ConnectionTestResult,
  type PaymentPort,
} from '../port';
import { asKcbBuniCredentials, type KcbBuniCredentials } from '../types';
import { extractPaymentReference } from '../payment-reference';
import type { InboundClaim, PlatformContext, VerificationOutcome, VerifyAttemptInput } from '../engine/types';
import { toCentsLoose } from '../daraja/security';
import { judgeAnswer, stateOf, unusableAnswer, type PlatformAnswer } from './status-judge';

import { asRecord, emptyToNull, has, orElse, readText } from '@/lib/values';

function formatPhoneKe(phone: string): string {
  let clean = phone.replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) clean = `254${clean.slice(1)}`;
  else if (clean.length === 9) clean = `254${clean}`;
  return clean;
}

export class KcbBuniAdapter implements PaymentPort {
  readonly code = 'kcb_buni' as const;
  readonly capabilities = ['collect', 'status_query'] as const;

  async testConnection(
    credentials: Record<string, unknown>,
    _settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<ConnectionTestResult> {
    const creds = asKcbBuniCredentials(credentials);
    return await probeConnection('KCB Buni', async () => {
      if (!has(creds.consumerKey) || !has(creds.consumerSecret)) throw new Error('The consumer key and secret are not saved yet.');
      await this.getAccessToken(apiBaseUrl, creds);
    });
  }


  private async getAccessToken(apiBaseUrl: string, creds: KcbBuniCredentials): Promise<string> {
    const auth = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64');
    const res = await fetch(`${apiBaseUrl}/token`, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) {
      throw new Error(`KCB Buni token failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { access_token?: string };
    if (!has(data.access_token)) throw new Error('KCB Buni token response missing access_token');
    return data.access_token;
  }

  async initiate(
    input: InitiatePaymentInput,
    credentials: Record<string, unknown>,
    settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<InitiatePaymentResult> {
    const creds = asKcbBuniCredentials(credentials);
    if (!has(creds.consumerKey) || !has(creds.consumerSecret) || !has(creds.orgShortCode)) {
      return {
        status: 'failed',
        errorMessage: 'KCB Buni credentials are incomplete. Configure them in admin.',
      };
    }

    try {
      const token = await this.getAccessToken(apiBaseUrl, creds);
      const path =
        typeof settings.stkPath === 'string'
          ? settings.stkPath
          : '/mm/api/request/1.0.0/stkpush';

      const body = {
        phoneNumber: formatPhoneKe(input.customerPhone),
        amount: String(Math.round(input.amount)),
        invoiceNumber: orElse(creds.invoiceNumber, input.orderNumber),
        sharedShortCode: creds.sharedShortCode !== false,
        orgShortCode: creds.orgShortCode,
        orgPassKey: orElse(creds.orgPassKey, ''),
        callbackUrl: input.callbackUrl,
        transactionDescription: (orElse(input.description, `Order ${input.orderNumber}`)).slice(0, 50),
      };

      const res = await fetch(`${apiBaseUrl}${path}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return {
          status: 'failed',
          errorMessage: readText(raw.message, raw.responseDescription, `KCB Buni STK failed (${res.status})`),
          rawResponse: raw,
        };
      }

      return {
        status: 'pending',
        providerReference: readText(raw.checkoutRequestID, raw.CheckoutRequestID, raw.conversationId, input.attemptId),
        externalReference: readText(raw.merchantRequestID, raw.MerchantRequestID, ''),
        customerMessage: readText(raw.customerMessage, raw.responseDescription, 'STK push sent'),
        rawResponse: raw,
      };
    } catch (err) {
      return {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'KCB Buni initiate failed',
      };
    }
  }

  /** A callback only points at the payment; it is never believed. */
  parseCallback(body: unknown): InboundClaim | null {
    const b = asRecord(body);
    const nested = asRecord(asRecord(b.Body).stkCallback);
    const source = Object.keys(nested).length > 0 ? nested : b;
    const checkout = readText(source.CheckoutRequestID, source.checkoutRequestID, '');
    if (!has(checkout)) return null;
    const code = Number(source.ResultCode ?? source.resultCode ?? source.statusCode ?? -1);
    const items = Array.isArray(asRecord(source.CallbackMetadata).Item) ? (asRecord(source.CallbackMetadata).Item as Record<string, unknown>[]) : [];
    const item = (name: string) => items.find((i) => i.Name === name)?.Value;
    return {
      kind: 'stk_callback',
      claimsSuccess: code === 0 || (code > 0 ? false : null),
      platformReference: emptyToNull(readText(item('MpesaReceiptNumber'), '')),
      conversationId: null,
      originatorId: null,
      requestIds: { checkoutRequestId: checkout, merchantRequestId: readText(source.MerchantRequestID, source.merchantRequestID, '') },
      amountCents: toCentsLoose(item('Amount')),
      currency: 'KES',
      payerFingerprint: null,
      payerMasked: null,
      shortcode: null,
      accountReference: null,
      occurredAt: null,
      failureCode: code > 0 ? String(code) : null,
      failureReason: code > 0 ? readText(source.ResultDesc, source.resultDesc, '') : null,
      extra: {},
    };
  }

  /** KCB's own record of the STK push, asked for by its checkout request id: result code, amount, receipt. */
  async verifyAttempt(input: VerifyAttemptInput, ctx: PlatformContext): Promise<VerificationOutcome> {
    const by = 'kcb_status';
    const creds = asKcbBuniCredentials(ctx.credentials);
    if (!has(creds.consumerKey) || !has(creds.consumerSecret) || !has(creds.orgShortCode)) {
      return { status: 'error', by, reason: 'The KCB Buni credentials are incomplete, so the payment cannot be checked.', retryable: false };
    }
    const checkout = input.providerReference;
    if (!has(checkout)) return { status: 'error', by, reason: 'This payment has no KCB checkout request id to ask about.', retryable: false };
    const claimed = input.claim?.requestIds.checkoutRequestId;
    if (has(claimed) && claimed !== checkout) {
      return { status: 'mismatch', by: 'cross_check', code: 'CHECKOUT_ID_MISMATCH', reason: `The notification names request ${claimed}, but this payment is ${checkout}.`, evidence: {} };
    }
    const base = ctx.provider.apiBaseUrl.replace(/\/$/, '');
    const basic = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64');
    const auth = await ctx.call({ label: 'oauth', provider: 'kcb_buni', method: 'POST', url: `${base}/token`, headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'grant_type=client_credentials', timeoutMs: 15000 });
    const token = readText(auth.json?.access_token, '');
    if (!has(token)) return { status: 'error', by, reason: `KCB did not give a token (${auth.reached ? String(auth.status) : (auth.networkError ?? 'no answer')}).`, retryable: true };
    const path = typeof ctx.settings.statusPath === 'string' ? ctx.settings.statusPath : '/mm/api/request/1.0.0/stkpushquery';
    const res = await ctx.call({ label: 'stk_query', provider: 'kcb_buni', method: 'POST', url: `${base}${path}`, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: { checkoutRequestID: checkout, orgShortCode: creds.orgShortCode }, timeoutMs: 20000 });
    const unusable = unusableAnswer(by, 'KCB', res);
    if (unusable) return unusable;
    const j = asRecord(res.json?.data ?? res.json);
    const raw = j.ResultCode ?? j.resultCode ?? j.statusCode;
    if (raw === undefined || raw === null || raw === '') return { status: 'error', by, reason: 'KCB\'s answer had no result code.', retryable: true };
    const code = Number(raw);
    const desc = readText(j.ResultDesc, j.resultDesc, j.message, '');
    const answer: PlatformAnswer = {
      state: stateOf(code === 0, Number.isFinite(code) && code > 0),
      reference: emptyToNull(readText(j.MpesaReceiptNumber, j.receiptNumber, j.transactionId, '')),
      amount: j.Amount ?? j.amount,
      currency: null,
      orderReference: null,
      reason: orElse(desc, code === 0 ? 'Paid.' : `ResultCode ${String(code)}`),
      evidence: { kcb: { ResultCode: raw, ResultDesc: desc, Amount: j.Amount ?? j.amount ?? null, MpesaReceiptNumber: j.MpesaReceiptNumber ?? j.receiptNumber ?? null, CheckoutRequestID: j.CheckoutRequestID ?? null } },
    };
    return judgeAnswer(by, answer, input, [input.orderNumber]);
  }

  handleCallback(input: CallbackInput): Promise<CallbackResult> {
    return Promise.resolve(this.readCallback(input));
  }

  private readCallback(input: CallbackInput): CallbackResult {
    const body = asRecord(input.body);
    const nested = (body.Body as Record<string, unknown> | undefined)?.stkCallback as
      | Record<string, unknown>
      | undefined;
    const resultCode = Number(
      nested?.ResultCode ?? body.ResultCode ?? body.resultCode ?? body.statusCode ?? -1,
    );
    const desc = readText(nested?.ResultDesc, body.ResultDesc, body.resultDesc, body.message, '');

    if (resultCode === 0 || String(body.status).toLowerCase() === 'success') {
      return {
        ok: true,
        status: 'successful',
        providerReference: readText(nested?.CheckoutRequestID, body.CheckoutRequestID, body.checkoutRequestID, ''),
        receiptNumber: extractPaymentReference('kcb_buni', body) ?? undefined,
        raw: body,
      };
    }
    if (resultCode > 0) {
      return {
        ok: true,
        status: 'failed',
        errorMessage: orElse(desc, `ResultCode ${resultCode}`),
        raw: body,
      };
    }
    return { ok: true, status: 'pending', raw: body, errorMessage: orElse(desc, undefined) };
  }
}
