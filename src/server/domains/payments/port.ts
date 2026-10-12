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

/** What a connected provider can do. The screens offer only what the adapter declares. */
export type ProviderCapability =
  | 'collect'
  | 'payout'
  | 'reverse'
  | 'status_query'
  | 'register_urls'
  | 'balance'
  | 'statement';

export interface ConnectionTestResult {
  ok: boolean;
  /** Safe to show: never contains a credential. */
  message: string;
}

/** Runs a harmless sign-in call and turns its outcome into a result a person can read. */
export async function probeConnection(
  label: string,
  signIn: () => Promise<unknown>,
): Promise<ConnectionTestResult> {
  try {
    await signIn();
    return { ok: true, message: `Signed in to ${label} successfully.` };
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    return { ok: false, message: text.replace(/\s+/g, ' ').trim().slice(0, 300) };
  }
}

/**
 * Payment provider contract. Each gateway implements this independently;
 * PaymentService + registry handle DI, attempt persistence, and callback routing.
 */
export interface PaymentPort {
  readonly code: PaymentProviderCode;
  /** What this adapter can do today. */
  readonly capabilities: readonly ProviderCapability[];
  /** Signs in with the saved credentials without moving money. */
  testConnection(
    credentials: Record<string, unknown>,
    settings: Record<string, unknown>,
    apiBaseUrl: string,
  ): Promise<ConnectionTestResult>;
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
