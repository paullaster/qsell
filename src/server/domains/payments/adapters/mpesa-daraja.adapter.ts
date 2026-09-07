import type {
  CallbackInput,
  CallbackResult,
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentPort,
} from '../port';
import type { MpesaDarajaCredentials } from '../types';

function formatPhoneKe(phone: string): string {
  let clean = phone.replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) clean = `254${clean.slice(1)}`;
  else if (clean.startsWith('254')) {
    /* ok */
  } else if (clean.length === 9) clean = `254${clean}`;
  return clean;
}

export class MpesaDarajaAdapter implements PaymentPort {
  readonly code = 'mpesa_daraja' as const;

  private async getAccessToken(
    apiBaseUrl: string,
    creds: MpesaDarajaCredentials,
  ): Promise<string> {
    const auth = Buffer.from(`${creds.consumerKey}:${creds.consumerSecret}`).toString('base64');
    const res = await fetch(
      `${apiBaseUrl}/oauth/v1/generate?grant_type=client_credentials`,
      {
        method: 'GET',
        headers: { Authorization: `Basic ${auth}` },
      },
    );
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`Daraja OAuth failed (${res.status}): ${text}`);
    }
    const data = (await res.json()) as { access_token?: string };
    if (!data.access_token) throw new Error('Daraja OAuth response missing access_token');
    return data.access_token;
  }

  async initiate(
    input: InitiatePaymentInput,
    credentials: Record<string, unknown>,
    _settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<InitiatePaymentResult> {
    const creds = credentials as MpesaDarajaCredentials;
    if (!creds.consumerKey || !creds.consumerSecret || !creds.shortcode || !creds.passkey) {
      return {
        status: 'failed',
        errorMessage: 'M-Pesa Daraja credentials are incomplete. Configure them in admin.',
      };
    }

    try {
      const token = await this.getAccessToken(apiBaseUrl, creds);
      const timestamp = new Date()
        .toISOString()
        .replace(/[^0-9]/g, '')
        .slice(0, 14);
      const password = Buffer.from(`${creds.shortcode}${creds.passkey}${timestamp}`).toString(
        'base64',
      );
      const phone = formatPhoneKe(input.customerPhone);
      const amount = Math.round(input.amount);

      const body = {
        BusinessShortCode: creds.shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: creds.transactionType || 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: creds.shortcode,
        PhoneNumber: phone,
        CallBackURL: input.callbackUrl,
        AccountReference: input.orderNumber.slice(0, 12),
        TransactionDesc: (input.description || `Order ${input.orderNumber}`).slice(0, 13),
      };

      const res = await fetch(`${apiBaseUrl}/mpesa/stkpush/v1/processrequest`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });
      const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok || String(raw.ResponseCode ?? '') !== '0') {
        return {
          status: 'failed',
          errorMessage:
            String(raw.errorMessage || raw.ResponseDescription || raw.errorMessage || '') ||
            `Daraja STK failed (${res.status})`,
          rawResponse: raw,
        };
      }

      return {
        status: 'pending',
        providerReference: String(raw.CheckoutRequestID || ''),
        externalReference: String(raw.MerchantRequestID || ''),
        customerMessage: String(raw.CustomerMessage || 'STK push sent'),
        rawResponse: raw,
      };
    } catch (err) {
      return {
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : 'Daraja initiate failed',
      };
    }
  }

  async handleCallback(input: CallbackInput): Promise<CallbackResult> {
    const body = input.body as {
      Body?: {
        stkCallback?: {
          MerchantRequestID?: string;
          CheckoutRequestID?: string;
          ResultCode?: number;
          ResultDesc?: string;
          CallbackMetadata?: {
            Item?: Array<{ Name: string; Value?: string | number }>;
          };
        };
      };
    };
    const cb = body?.Body?.stkCallback;
    if (!cb) {
      return { ok: false, status: 'failed', errorMessage: 'Invalid Daraja callback payload' };
    }

    const resultCode = Number(cb.ResultCode);
    const items = cb.CallbackMetadata?.Item || [];
    const receipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;

    if (resultCode === 0) {
      return {
        ok: true,
        status: 'successful',
        providerReference: cb.CheckoutRequestID,
        externalReference: cb.MerchantRequestID,
        receiptNumber: receipt != null ? String(receipt) : undefined,
        raw: body as Record<string, unknown>,
      };
    }

    return {
      ok: true,
      status: 'failed',
      providerReference: cb.CheckoutRequestID,
      externalReference: cb.MerchantRequestID,
      errorMessage: cb.ResultDesc || `ResultCode ${resultCode}`,
      raw: body as Record<string, unknown>,
    };
  }
}
