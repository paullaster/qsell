import type {
  CallbackInput,
  CallbackResult,
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentPort,
} from '../port';
import type { PesapalCredentials } from '../types';
import { extractPaymentReference } from '../payment-reference';

export class PesapalV3Adapter implements PaymentPort {
  readonly code = 'pesapal_v3' as const;

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
    const creds = credentials as PesapalCredentials;
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
