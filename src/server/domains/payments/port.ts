import type { PaymentProviderCode } from './types';

export interface InitiatePaymentInput {
  attemptId: string;
  orderId: string;
  orderNumber: string;
  amount: number;
  currency: string;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** Absolute HTTPS callback URL ending with /<uuidv7> */
  callbackUrl: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

export interface InitiatePaymentResult {
  status: 'pending' | 'awaiting_redirect' | 'failed';
  providerReference?: string;
  externalReference?: string;
  redirectUrl?: string;
  customerMessage?: string;
  rawResponse?: Record<string, unknown>;
  errorMessage?: string;
}

export interface CallbackInput {
  callbackToken: string;
  headers: Record<string, string>;
  body: unknown;
  rawBodyText?: string;
}

export interface CallbackResult {
  ok: boolean;
  status: 'successful' | 'failed' | 'pending';
  providerReference?: string;
  externalReference?: string;
  receiptNumber?: string;
  raw?: Record<string, unknown>;
  errorMessage?: string;
}

/**
 * Payment provider contract. Each gateway implements this independently;
 * PaymentService + registry handle DI, attempt persistence, and callback routing.
 */
export interface PaymentPort {
  readonly code: PaymentProviderCode;
  initiate(
    input: InitiatePaymentInput,
    credentials: Record<string, unknown>,
    settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<InitiatePaymentResult>;
  handleCallback(
    input: CallbackInput,
    credentials: Record<string, unknown>,
    settings: Record<string, unknown>,
  ): Promise<CallbackResult>;
  queryStatus?(
    refs: { providerReference?: string; externalReference?: string },
    credentials: Record<string, unknown>,
    settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<CallbackResult>;
}
