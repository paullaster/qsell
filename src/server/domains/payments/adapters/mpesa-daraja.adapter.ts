import type {
  CallbackInput,
  CallbackResult,
  InitiatePaymentInput,
  InitiatePaymentResult,
  PaymentPort,
} from '../port';
import type { MpesaDarajaCredentials } from '../types';
import { extractPaymentReference } from '../payment-reference';

function formatPhoneKe(phone: string): string {
  let clean = phone.replace(/[^0-9]/g, '');
  if (clean.startsWith('0')) clean = `254${clean.slice(1)}`;
  else if (clean.startsWith('254')) {
    /* ok */
  } else if (clean.length === 9) clean = `254${clean}`;
  return clean;
}

type CachedDarajaToken = { token: string; expiresAt: number };

/** In-process cache. Daraja access tokens last about an hour. */
const darajaTokenCache = new Map<string, CachedDarajaToken>();
const TOKEN_EXPIRY_BUFFER_MS = 60_000;

function darajaTokenCacheKey(apiBaseUrl: string, consumerKey: string): string {
  return `${apiBaseUrl.replace(/\/$/, '')}|${consumerKey}`;
}

export class MpesaDarajaAdapter implements PaymentPort {
  readonly code = 'mpesa_daraja' as const;

  private async getAccessToken(
    apiBaseUrl: string,
    creds: MpesaDarajaCredentials,
  ): Promise<string> {
    const consumerKey = creds.consumerKey.trim();
    const consumerSecret = creds.consumerSecret.trim();
    const cacheKey = darajaTokenCacheKey(apiBaseUrl, consumerKey);
    const cached = darajaTokenCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.token;
    }

    const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
    const res = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/oauth/v1/generate?grant_type=client_credentials`, {
      method: 'GET',
      headers: {
        Authorization: `Basic ${auth}`,
        Accept: 'application/json',
      },
    });
    if (!res.ok) {
      const text = (await res.text()).trim();
      darajaTokenCache.delete(cacheKey);
      const requestId = res.headers.get('x-request-id');
      const blockedByGateway = !text && (res.headers.get('x-cdn') || '').toLowerCase() === 'imperva';
      const detail = text
        ? text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').slice(0, 240)
        : blockedByGateway
          ? `Safaricom's sandbox gateway blocked the token request before issuing one${requestId ? ` (request ${requestId})` : ''}. In the Daraja portal, copy this app's sandbox consumer key and secret again, confirm the app is active, and save them under Settings → Payments. The base URL must be https://sandbox.safaricom.co.ke.`
          : `Daraja OAuth failed (${res.status}) with an empty body${requestId ? ` (request ${requestId})` : ''}.`;
      throw new Error(text ? `Daraja OAuth failed (${res.status}): ${detail}` : detail);
    }
    const data = (await res.json()) as { access_token?: string; expires_in?: string | number };
    if (!data.access_token) throw new Error('Daraja OAuth response missing access_token');

    const expiresInSec = Number(data.expires_in);
    const lifetimeMs =
      Number.isFinite(expiresInSec) && expiresInSec > 0 ? expiresInSec * 1000 : 3_600_000;
    darajaTokenCache.set(cacheKey, {
      token: data.access_token,
      expiresAt: Date.now() + Math.max(30_000, lifetimeMs - TOKEN_EXPIRY_BUFFER_MS),
    });
    return data.access_token;
  }

  async initiate(
    input: InitiatePaymentInput,
    credentials: Record<string, unknown>,
    _settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<InitiatePaymentResult> {
    const creds = credentials as MpesaDarajaCredentials;
    const shortcode = creds.shortcode?.trim();
    const passkey = creds.passkey?.trim();
    if (!creds.consumerKey?.trim() || !creds.consumerSecret?.trim() || !shortcode || !passkey) {
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
      const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
      const phone = formatPhoneKe(input.customerPhone);
      const amount = Math.round(input.amount);

      const body = {
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: creds.transactionType || 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phone,
        PartyB: shortcode,
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
    const receipt = extractPaymentReference('mpesa_daraja', body);

    if (resultCode === 0) {
      return {
        ok: true,
        status: 'successful',
        providerReference: cb.CheckoutRequestID,
        externalReference: cb.MerchantRequestID,
        receiptNumber: receipt ?? undefined,
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
