import {
  probeConnection,
  type CallbackInput,
  type CallbackResult,
  type InitiatePaymentInput,
  type InitiatePaymentResult,
  type ConnectionTestResult,
  type PaymentPort,
} from '../port';
import { asPesapalCredentials, type PesapalCredentials } from '../types';
import { extractPaymentReference } from '../payment-reference';
import type { InboundClaim, PlatformContext, VerificationOutcome, VerifyAttemptInput } from '../engine/types';
import { toCentsLoose } from '../daraja/security';

export class PesapalV3Adapter implements PaymentPort {
  readonly code = 'pesapal_v3' as const;
  readonly capabilities = ['collect', 'status_query'] as const;

  async testConnection(
    credentials: Record<string, unknown>,
    _settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<ConnectionTestResult> {
    const creds = asPesapalCredentials(credentials);
    return await probeConnection('Pesapal', async () => {
      if (!creds.consumerKey || !creds.consumerSecret) throw new Error('The consumer key and secret are not saved yet.');
      await this.getAccessToken(apiBaseUrl, creds);
    });
  }


  private async getAccessToken(apiBaseUrl: string, creds: PesapalCredentials): Promise<string> {
    const res = await fetch(`${apiBaseUrl}/api/Auth/RequestToken`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        consumer_key: creds.consumerKey,
        consumer_secret: creds.consumerSecret,
      }),
    });
    if (!res.ok) {
      throw new Error(`Pesapal auth failed (${res.status}): ${await res.text()}`);
    }
    const data = (await res.json()) as { token?: string };
    if (!data.token) throw new Error('Pesapal auth missing token');
    return data.token;
  }

  async initiate(
    input: InitiatePaymentInput,
    credentials: Record<string, unknown>,
    settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<InitiatePaymentResult> {
    const creds = asPesapalCredentials(credentials);
    if (!creds.consumerKey || !creds.consumerSecret) {
      return {
        status: 'failed',
        errorMessage: 'Pesapal credentials are incomplete. Configure them in admin.',
      };
    }

    try {
      const token = await this.getAccessToken(apiBaseUrl, creds);
      const notificationId =
        creds.ipnId || (typeof settings.ipnId === 'string' ? settings.ipnId : '');

      const body = {
        id: input.orderNumber,
        currency: input.currency,
        amount: input.amount,
        description: input.description || `Order ${input.orderNumber}`,
        callback_url: input.callbackUrl,
        notification_id: notificationId || undefined,
        billing_address: {
          email_address: input.customerEmail,
          phone_number: input.customerPhone,
          first_name: input.customerName.split(' ')[0] || input.customerName,
          last_name: input.customerName.split(' ').slice(1).join(' ') || input.customerName,
        },
      };

      const res = await fetch(`${apiBaseUrl}/api/Transactions/SubmitOrderRequest`, {
        method: 'POST',
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify(body),
      });
      const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        return {
          status: 'failed',
          errorMessage: String(raw.message || raw.error || `Pesapal submit failed (${res.status})`),
          rawResponse: raw,
        };
      }

      return {
        status: 'awaiting_redirect',
        providerReference: String(raw.merchant_reference || input.orderNumber),
        externalReference: String(raw.order_tracking_id || ''),
        redirectUrl: String(raw.redirect_url || ''),
        rawResponse: raw,
      };
    } catch (err) {
      return {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Pesapal initiate failed',
      };
    }
  }

  /** An IPN only tells us which order to look at; it is never believed. */
  parseCallback(body: unknown): InboundClaim | null {
    const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
    const tracking = String(b.OrderTrackingId ?? b.order_tracking_id ?? '');
    if (!tracking) return null;
    return {
      kind: 'ipn',
      claimsSuccess: null,
      platformReference: null,
      conversationId: tracking,
      originatorId: null,
      requestIds: { orderTrackingId: tracking, merchantReference: String(b.OrderMerchantReference ?? b.order_merchant_reference ?? '') },
      amountCents: null,
      currency: 'KES',
      payerFingerprint: null,
      payerMasked: null,
      shortcode: null,
      accountReference: String(b.OrderMerchantReference ?? '') || null,
      occurredAt: null,
      failureCode: null,
      failureReason: null,
      extra: { notificationType: String(b.OrderNotificationType ?? '') },
    };
  }

  /** Pesapal's own record of the order, asked for by its tracking id: status, amount, merchant reference. */
  async verifyAttempt(input: VerifyAttemptInput, ctx: PlatformContext): Promise<VerificationOutcome> {
    const creds = asPesapalCredentials(ctx.credentials);
    const base = ctx.provider.apiBaseUrl.replace(/\/$/, '');
    const tracking = input.externalReference;
    if (!tracking) return { status: 'error', by: 'pesapal_status', reason: 'This payment has no Pesapal tracking id to ask about.', retryable: false };
    const claimed = input.claim?.requestIds.orderTrackingId;
    if (claimed && claimed !== tracking) {
      return { status: 'mismatch', by: 'cross_check', code: 'TRACKING_ID_MISMATCH', reason: `The notification names order ${claimed}, but this payment is ${tracking}.`, evidence: {} };
    }
    const tokenRes = await ctx.call({ label: 'oauth', provider: 'pesapal_v3', method: 'POST', url: `${base}/api/Auth/RequestToken`, body: { consumer_key: creds.consumerKey, consumer_secret: creds.consumerSecret }, timeoutMs: 15000 });
    const token = typeof tokenRes.json?.token === 'string' ? tokenRes.json.token : null;
    if (!token) return { status: 'error', by: 'pesapal_status', reason: `Pesapal did not give a token (${tokenRes.reached ? tokenRes.status : tokenRes.networkError}).`, retryable: true };
    const res = await ctx.call({ label: 'get_transaction_status', provider: 'pesapal_v3', method: 'GET', url: `${base}/api/Transactions/GetTransactionStatus?orderTrackingId=${encodeURIComponent(tracking)}`, headers: { Authorization: `Bearer ${token}` }, timeoutMs: 20000 });
    if (!res.reached || res.status >= 500 || res.status === 429) return { status: 'error', by: 'pesapal_status', reason: res.networkError ?? `Pesapal answered ${res.status}.`, retryable: true };
    const j = res.json ?? {};
    if (res.status >= 400 || !('status_code' in j || 'payment_status_description' in j)) {
      return { status: 'error', by: 'pesapal_status', reason: `Pesapal's answer could not be used (${res.status}): ${String(j.message ?? j.error ?? res.text).slice(0, 200)}`, retryable: res.status !== 400 && res.status !== 404 };
    }
    const evidence = { pesapal: { status_code: j.status_code ?? null, payment_status_description: j.payment_status_description ?? null, merchant_reference: j.merchant_reference ?? null, confirmation_code: j.confirmation_code ?? null, amount: j.amount ?? null, currency: j.currency ?? null } };
    const status = String(j.payment_status_description ?? '').toLowerCase();
    const code = String(j.status_code ?? '');
    if (status === 'completed' || code === '1') {
      if (j.merchant_reference && String(j.merchant_reference) !== input.orderNumber) {
        return { status: 'mismatch', by: 'pesapal_status', code: 'MERCHANT_REFERENCE_MISMATCH', reason: `Pesapal says this order belongs to ${String(j.merchant_reference)}, not ${input.orderNumber}.`, evidence };
      }
      const amount = toCentsLoose(j.amount);
      if (amount === null || amount !== input.amountCents) {
        return { status: 'mismatch', by: 'pesapal_status', code: 'AMOUNT_MISMATCH', reason: `Pesapal says ${j.amount ?? 'no amount'} was paid, but ${(input.amountCents / 100).toFixed(2)} was asked for.`, evidence };
      }
      if (j.currency && String(j.currency).toUpperCase() !== input.currency.toUpperCase()) {
        return { status: 'mismatch', by: 'pesapal_status', code: 'CURRENCY_MISMATCH', reason: `Pesapal says the currency is ${String(j.currency)}, not ${input.currency}.`, evidence };
      }
      const confirmation = j.confirmation_code ? String(j.confirmation_code) : null;
      return { status: 'confirmed', by: 'pesapal_status', platformReference: confirmation ?? tracking, amountCents: amount, evidence };
    }
    if (status === 'failed' || status === 'invalid' || status === 'reversed' || ['0', '2', '3'].includes(code)) {
      return { status: 'failed', by: 'pesapal_status', code: code || status, reason: String(j.message ?? j.payment_status_description ?? 'Pesapal reports the payment did not go through.'), evidence };
    }
    return { status: 'pending', by: 'pesapal_status', reason: `Pesapal reports "${String(j.payment_status_description ?? 'pending')}".`, evidence };
  }

  async handleCallback(input: CallbackInput): Promise<CallbackResult> {
    const body = (input.body || {}) as Record<string, unknown>;
    const status =
      String(body.payment_status_description || body.status || body.OrderNotificationType || '')
        .toLowerCase();
    const trackingId = String(
      body.OrderTrackingId || body.order_tracking_id || body.OrderMerchantReference || '',
    );

    if (status.includes('completed') || status.includes('paid') || status === '1') {
      return {
        ok: true,
        status: 'successful',
        externalReference: trackingId,
        providerReference: String(body.OrderMerchantReference || body.merchant_reference || ''),
        receiptNumber: extractPaymentReference('pesapal_v3', body) ?? undefined,
        raw: body,
      };
    }
    if (status.includes('failed') || status.includes('invalid')) {
      return {
        ok: true,
        status: 'failed',
        externalReference: trackingId,
        errorMessage: String(body.message || status),
        raw: body,
      };
    }
    return { ok: true, status: 'pending', externalReference: trackingId, raw: body };
  }
}
