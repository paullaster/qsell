import type {
  CallbackInput,
  CallbackResult,
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentPort,
} from '../port';
import type { KcbBuniCredentials } from '../types';
import { extractPaymentReference } from '../payment-reference';

function formatPhoneKe(phone: string): string {
  let clean = phone.replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) clean = `254${clean.slice(1)}`;
  else if (clean.length === 9) clean = `254${clean}`;
  return clean;
}

export class KcbBuniAdapter implements PaymentPort {
  readonly code = 'kcb_buni' as const;

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
    if (!data.access_token) throw new Error('KCB Buni token response missing access_token');
    return data.access_token;
  }

  async initiate(
    input: InitiatePaymentInput,
    credentials: Record<string, unknown>,
    settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<InitiatePaymentResult> {
    const creds = credentials as KcbBuniCredentials;
    if (!creds.consumerKey || !creds.consumerSecret || !creds.orgShortCode) {
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
        invoiceNumber: creds.invoiceNumber || input.orderNumber,
        sharedShortCode: creds.sharedShortCode !== false,
        orgShortCode: creds.orgShortCode,
        orgPassKey: creds.orgPassKey || '',
        callbackUrl: input.callbackUrl,
        transactionDescription: (input.description || `Order ${input.orderNumber}`).slice(0, 50),
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
          errorMessage: String(
            raw.message || raw.responseDescription || `KCB Buni STK failed (${res.status})`,
          ),
          rawResponse: raw,
        };
      }

      return {
        status: 'pending',
        providerReference: String(
          raw.checkoutRequestID || raw.CheckoutRequestID || raw.conversationId || input.attemptId,
        ),
        externalReference: String(raw.merchantRequestID || raw.MerchantRequestID || ''),
        customerMessage: String(raw.customerMessage || raw.responseDescription || 'STK push sent'),
        rawResponse: raw,
      };
    } catch (err) {
      return {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'KCB Buni initiate failed',
      };
    }
  }

  async handleCallback(input: CallbackInput): Promise<CallbackResult> {
    const body = (input.body || {}) as Record<string, unknown>;
    const nested = (body.Body as Record<string, unknown> | undefined)?.stkCallback as
      | Record<string, unknown>
      | undefined;
    const resultCode = Number(
      nested?.ResultCode ?? body.ResultCode ?? body.resultCode ?? body.statusCode ?? -1,
    );
    const desc = String(
      nested?.ResultDesc || body.ResultDesc || body.resultDesc || body.message || '',
    );

    if (resultCode === 0 || String(body.status).toLowerCase() === 'success') {
      return {
        ok: true,
        status: 'successful',
        providerReference: String(
          nested?.CheckoutRequestID || body.CheckoutRequestID || body.checkoutRequestID || '',
        ),
        receiptNumber: extractPaymentReference('kcb_buni', body) ?? undefined,
        raw: body,
      };
    }
    if (resultCode > 0) {
      return {
        ok: true,
        status: 'failed',
        errorMessage: desc || `ResultCode ${resultCode}`,
        raw: body,
      };
    }
    return { ok: true, status: 'pending', raw: body, errorMessage: desc || undefined };
  }
}
