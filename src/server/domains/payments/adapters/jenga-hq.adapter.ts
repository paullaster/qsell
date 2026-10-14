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

/**
 * Jenga HQ receive-money / checkout adapter.
 * Signature formula follows Jenga docs (SHA-256 RSA over concatenated fields).
 */
export class JengaHqAdapter implements PaymentPort {
  readonly code = 'jenga_hq' as const;
  readonly capabilities = ['collect'] as const;

  async testConnection(
    credentials: Record<string, unknown>,
    _settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<ConnectionTestResult> {
    const creds = asJengaCredentials(credentials);
    return probeConnection('Jenga', async () => {
      if (!creds.merchantCode || !creds.consumerSecret || !creds.apiKey) throw new Error('The merchant code, consumer secret and API key are not all saved yet.');
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
    const token = data.accessToken || data.token;
    if (!token) throw new Error('Jenga auth missing access token');
    return token;
  }

  async initiate(
    input: InitiatePaymentInput,
    credentials: Record<string, unknown>,
    settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<InitiatePaymentResult> {
    const creds = asJengaCredentials(credentials);
    if (!creds.merchantCode || !creds.consumerSecret || !creds.apiKey || !creds.privateKeyPem) {
      return {
        status: 'failed',
        errorMessage: 'Jenga HQ credentials are incomplete. Configure them in admin.',
      };
    }

    try {
      const token = await this.authenticate(apiBaseUrl, creds);
      const countryCode = String(settings.countryCode || 'KE');
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
          description: input.description || `Order ${input.orderNumber}`,
          callbackUrl: input.callbackUrl,
        },
        customer: {
          name: input.customerName,
          email: input.customerEmail,
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
          errorMessage: String(raw.message || raw.responseMessage || `Jenga failed (${res.status})`),
          rawResponse: raw,
        };
      }

      const redirect =
        typeof raw.redirectUrl === 'string'
          ? raw.redirectUrl
          : typeof raw.paymentUrl === 'string'
            ? raw.paymentUrl
            : undefined;

      return {
        status: redirect ? 'awaiting_redirect' : 'pending',
        providerReference: String(raw.transactionId || raw.transactionReference || ref),
        externalReference: String(raw.reference || ref),
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

  async handleCallback(input: CallbackInput): Promise<CallbackResult> {
    const body = (input.body || {}) as Record<string, unknown>;
    const status = String(body.status || body.transactionStatus || body.state || '').toLowerCase();
    if (status.includes('success') || status.includes('completed') || status === '0') {
      return {
        ok: true,
        status: 'successful',
        providerReference: String(body.transactionId || body.transactionReference || ''),
        receiptNumber: extractPaymentReference('jenga_hq', body) ?? undefined,
        raw: body,
      };
    }
    if (status.includes('fail') || status.includes('error')) {
      return {
        ok: true,
        status: 'failed',
        errorMessage: String(body.message || body.responseMessage || status),
        raw: body,
      };
    }
    return { ok: true, status: 'pending', raw: body };
  }
}
