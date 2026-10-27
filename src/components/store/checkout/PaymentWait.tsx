'use client';

import { useEffect, useRef, useState } from 'react';
import { CreditCard, RefreshCw, ShieldCheck, Smartphone } from 'lucide-react';
import type { Order } from '@/types/index';
import { getPaymentAttemptStatusAction } from '@/server/actions';
import { firstFilled, orElse } from '@/lib/values';
import { maskedPhone } from '@/lib/phone';
import type { CheckoutPayment } from '@/server/domains/orders/checkout-actions';

const POLL_MS = 2500;
const WAIT_SECONDS = 120;

type Waiting = Extract<CheckoutPayment, { kind: 'stk' | 'hosted' }>;

/**
 * Waits for a payment to be confirmed by asking the shop (never by trusting the browser): the order is shown as paid only once
 * the payment provider has told the server so. A prompt on the phone and a provider's own page are the same wait.
 */
export function PaymentWait({
  order,
  payment,
  onPaid,
  onFailed,
}: {
  order: Order;
  payment: Waiting;
  onPaid: (receipt: string) => void;
  onFailed: (reason: string) => void;
}) {
  const [seconds, setSeconds] = useState(WAIT_SECONDS);
  // The newest callbacks, so a re-render of the parent does not restart the polling.
  const paid = useRef(onPaid);
  const failed = useRef(onFailed);
  useEffect(() => {
    paid.current = onPaid;
    failed.current = onFailed;
  }, [onPaid, onFailed]);

  useEffect(() => {
    const tick = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    const poll = setInterval(() => {
      getPaymentAttemptStatusAction(payment.attemptId)
        .then((attempt) => {
          if (attempt.status === 'successful') {
            clearInterval(poll);
            clearInterval(tick);
            paid.current(firstFilled(attempt.receiptNumber, attempt.providerReference) ?? 'PAID');
          } else if (attempt.status === 'failed' || attempt.status === 'cancelled') {
            clearInterval(poll);
            clearInterval(tick);
            failed.current(orElse(attempt.errorMessage, 'The payment was not completed.'));
          }
        })
        .catch(() => undefined); // not answered yet: ask again
    }, POLL_MS);
    return () => {
      clearInterval(tick);
      clearInterval(poll);
    };
  }, [payment.attemptId]);

  const phone = payment.kind === 'stk';
  return (
    <section aria-label="Waiting for payment" className="mx-auto max-w-lg space-y-4 rounded-2xl border border-line bg-surface-raised p-6 text-center shadow-lg">
      <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-600">
        {phone ? <Smartphone className="h-7 w-7" aria-hidden="true" /> : <CreditCard className="h-7 w-7" aria-hidden="true" />}
      </div>
      <h1 className="text-xl font-bold text-fg-strong">{phone ? 'Check your phone' : 'Complete your payment'}</h1>
      <p role="status" aria-live="polite" className="text-sm text-fg">{payment.message}</p>
      {phone && maskedPhone(order.paymentPhone ?? order.customerPhone) !== '' ? <p className="text-sm text-fg-muted">The prompt was sent to <span className="font-mono text-fg-strong">{maskedPhone(order.paymentPhone ?? order.customerPhone)}</span>.</p> : null}
      {payment.kind === 'hosted' && payment.redirectUrl !== null ? (
        <a href={payment.redirectUrl} target="_blank" rel="noopener noreferrer" className="inline-flex min-h-11 items-center justify-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500">
          Open the payment page
        </a>
      ) : null}
      <p className="font-mono text-xs text-fg-muted">Order {order.orderNumber}</p>
      <p className="flex items-center justify-center gap-2 text-sm text-fg-muted">
        <RefreshCw className="h-4 w-4 animate-spin" aria-hidden="true" />
        {seconds > 0 ? `Waiting for confirmation · ${String(seconds)}s` : 'Still waiting. Please do not start another payment: this page updates as soon as the provider answers.'}
      </p>
      <p className="flex items-center justify-center gap-1.5 text-xs text-fg-muted"><ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />Your order is saved. It is confirmed only when the payment is.</p>
    </section>
  );
}
