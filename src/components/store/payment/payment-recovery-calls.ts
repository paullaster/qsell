import { myOrderClaimPaymentAction, myOrderClaimStatusAction, myOrderPayAgainAction, myOrderPayOptionsAction, myOrderRefreshPaymentAction } from '@/server/domains/customers/actions';
import { trackClaimPaymentAction, trackClaimStatusAction, trackPayAgainAction, trackPayOptionsAction, trackRefreshPaymentAction } from '@/server/domains/orders/track-payment-actions';
import type { ClaimAnswer, PayOptions } from '@/server/domains/payments/payment-claims';
import type { CheckoutPayment } from '@/server/domains/orders/payment-start';

/** How the shopper reached the order: their account, or the link in their message. Either way the server proves it again on every call. */
export type RecoveryMode = { kind: 'account'; orderId: string } | { kind: 'track'; token: string };

export type Answer<T> = { ok: true; data: T } | { ok: false; error: string; code?: string };

export interface RecoveryCalls {
  options: () => Promise<Answer<PayOptions>>;
  refresh: () => Promise<Answer<{ paid: boolean }>>;
  claim: (method: string, code: string) => Promise<Answer<ClaimAnswer>>;
  status: (attemptId: string) => Promise<Answer<ClaimAnswer>>;
  payAgain: (method: string, paymentPhone: string) => Promise<Answer<CheckoutPayment | { kind: 'paid' }>>;
}

/** The five things a shopper can do about an order waiting for its payment, for the way they reached it. */
export function callsFor(mode: RecoveryMode): RecoveryCalls {
  if (mode.kind === 'account') {
    const orderId = mode.orderId;
    return {
      options: () => myOrderPayOptionsAction(orderId),
      refresh: () => myOrderRefreshPaymentAction(orderId),
      claim: (method, code) => myOrderClaimPaymentAction({ orderId, method, code }),
      status: (attemptId) => myOrderClaimStatusAction({ orderId, attemptId }),
      payAgain: (method, paymentPhone) => myOrderPayAgainAction({ orderId, method, paymentPhone }),
    };
  }
  const token = mode.token;
  return {
    options: () => trackPayOptionsAction(token),
    refresh: () => trackRefreshPaymentAction(token),
    claim: (method, code) => trackClaimPaymentAction({ token, method, code }),
    status: (attemptId) => trackClaimStatusAction({ token, attemptId }),
    payAgain: (method, paymentPhone) => trackPayAgainAction({ token, method, paymentPhone }),
  };
}
