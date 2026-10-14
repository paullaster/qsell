import type { PaymentProviderConfigRow } from '@/server/db/drizzle/schema';
import type { HttpCallInput, HttpCallResult } from './http-client';

/** Everything a platform driver needs to talk to its platform for one provider. */
export interface PlatformContext {
  companyId: string;
  provider: PaymentProviderConfigRow;
  /** Opened credentials. Never logged. */
  credentials: Record<string, string>;
  /** Non-secret settings of the provider. */
  settings: Record<string, unknown>;
  /** Every outbound call goes through here, so it is timed, redacted and logged. */
  call: (input: Omit<HttpCallInput, 'companyId' | 'providerId'>) => Promise<HttpCallResult>;
  publicBaseUrl: string | null;
  now: () => Date;
}

/** What a callback says. It is a claim: nothing in it is believed until the platform confirms it. */
export interface InboundClaim {
  kind: string;
  /** What the callback says happened. */
  claimsSuccess: boolean | null;
  platformReference: string | null;
  conversationId: string | null;
  originatorId: string | null;
  /** Our own request ids echoed back (CheckoutRequestID, MerchantRequestID...). */
  requestIds: Record<string, string>;
  amountCents: number | null;
  currency: string;
  /** The payer's number is never kept: only a one-way fingerprint (to compare) and a masked form (to show). */
  payerFingerprint: string | null;
  payerMasked: string | null;
  shortcode: string | null;
  accountReference: string | null;
  occurredAt: Date | null;
  failureCode: string | null;
  failureReason: string | null;
  extra: Record<string, unknown>;
}

export type VerificationOutcome =
  /** The platform itself says this transaction exists, succeeded, and matches what we asked for. */
  | { status: 'confirmed'; by: string; platformReference: string | null; amountCents: number | null; evidence: Record<string, unknown> }
  /** The platform itself says it did not succeed (cancelled, declined, expired...). */
  | { status: 'failed'; by: string; code: string; reason: string; evidence: Record<string, unknown> }
  /** The platform has not decided yet: ask again. */
  | { status: 'pending'; by: string; reason: string; evidence: Record<string, unknown> }
  /** The callback contradicts what we asked for or what the platform says: never consumed. */
  | { status: 'mismatch'; by: string; code: string; reason: string; evidence: Record<string, unknown> }
  /** The question could not be asked or answered (network, platform error): ask again. */
  | { status: 'error'; by: string; reason: string; retryable: boolean }
  /** This platform has no way for us to check: the payment cannot be consumed automatically. */
  | { status: 'unavailable'; reason: string };

export interface VerifyAttemptInput {
  attemptId: string;
  orderNumber: string;
  amountCents: number;
  currency: string;
  customerPhone: string | null;
  providerReference: string | null;
  externalReference: string | null;
  createdAt: Date;
  /** The latest callback's claim, if one arrived. */
  claim: InboundClaim | null;
  /** How the provider is set to verify. */
  mode: 'standard' | 'strict';
  /** Evidence already gathered (for example a transaction-status answer that arrived later). */
  evidence: Record<string, unknown>[];
}
