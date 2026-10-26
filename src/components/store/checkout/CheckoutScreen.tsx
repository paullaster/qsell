'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { ShoppingBag } from 'lucide-react';
import type { Order, PaymentProvider } from '@/types/index';
import { confirmedOrderAction, placeOrderAction, retryPaymentAction, type CheckoutPayment } from '@/server/domains/orders/checkout-actions';
import { useCart } from '@/components/store/cart/CartProvider';
import { useStore } from '@/components/store/StoreContext';
import { CheckoutForm, type CheckoutSubmission } from '@/components/store/checkout/CheckoutForm';
import { OrderComplete } from '@/components/store/checkout/OrderComplete';
import { PaymentWait } from '@/components/store/checkout/PaymentWait';

type Stage =
  | { name: 'form' }
  | { name: 'paying'; order: Order; payment: Extract<CheckoutPayment, { kind: 'stk' | 'hosted' }>; method: PaymentProvider }
  | { name: 'payment_failed'; order: Order; message: string; method: PaymentProvider }
  | { name: 'done'; order: Order; receipt: string | null; onAccount: boolean };

/** The checkout, as a page: the form, then the wait for the payment, then the confirmation. */
export function CheckoutScreen() {
  const cart = useCart();
  const { company } = useStore();
  const [stage, setStage] = useState<Stage>({ name: 'form' });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { refresh, ready } = cart;

  // Prices and stock are read fresh when checkout opens; anything that moved is told to the shopper.
  useEffect(() => {
    if (ready) void refresh();
    // Once per visit, when the saved cart has first been read.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /** Where a payment goes next: waiting for the provider, or failed with a reason. */
  const route = (order: Order, payment: CheckoutPayment, method: PaymentProvider): Stage => {
    if (payment.kind === 'none') return { name: 'done', order, receipt: null, onAccount: true };
    if (payment.kind === 'failed') return { name: 'payment_failed', order, message: payment.message, method };
    if (payment.kind === 'hosted' && payment.redirectUrl !== null) window.open(payment.redirectUrl, '_blank', 'noopener,noreferrer');
    return { name: 'paying', order, payment, method };
  };

  const place = async (data: CheckoutSubmission) => {
    setSubmitting(true);
    setError(null);
    try {
      const result = await placeOrderAction({ ...data, items: cart.lines.map((line) => ({ productId: line.product.id, quantity: line.quantity })) });
      if (!result.ok) {
        setError(result.error);
        // The reason may be that something in the cart moved; show the cart as it is now.
        void cart.refresh();
        return;
      }
      // The order now holds the stock, so the cart is spent whatever happens to the payment.
      cart.clear();
      setStage(route(result.data.order, result.data.payment, data.paymentMethod));
    } catch {
      setError('We could not reach the shop. Please check your connection and try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const paid = async (order: Order, receipt: string) => {
    // What is shown is what the shop has recorded, not what this page assumes.
    const contact = order.customerEmail.trim() === '' ? order.customerPhone : order.customerEmail;
    const confirmed = await confirmedOrderAction({ orderNumber: order.orderNumber, contact }).catch(() => null);
    setStage({ name: 'done', order: confirmed?.ok === true && confirmed.data !== null ? confirmed.data : order, receipt, onAccount: false });
  };

  const retry = async (order: Order, method: PaymentProvider) => {
    setSubmitting(true);
    try {
      const result = await retryPaymentAction({ orderId: order.id, providerCode: method });
      setStage(result.ok ? route(order, result.data, method) : { name: 'payment_failed', order, message: result.error, method });
    } finally {
      setSubmitting(false);
    }
  };

  if (stage.name === 'done') return <OrderComplete order={stage.order} receipt={stage.receipt} onAccount={stage.onAccount} />;
  if (stage.name === 'paying') {
    return <PaymentWait order={stage.order} payment={stage.payment} onPaid={(receipt) => void paid(stage.order, receipt)} onFailed={(message) => setStage({ name: 'payment_failed', order: stage.order, message, method: stage.method })} />;
  }
  if (stage.name === 'payment_failed') {
    return (
      <section aria-label="Payment not completed" className="mx-auto max-w-lg space-y-4 rounded-2xl border border-line bg-surface-raised p-6 text-center shadow-lg">
        <h1 className="text-xl font-bold text-fg-strong">The payment did not go through</h1>
        <p role="alert" className="text-sm text-fg">{stage.message}</p>
        <p className="text-sm text-fg-muted">Your order <span className="font-mono text-fg-strong">{stage.order.orderNumber}</span> is saved and nothing has been charged twice. You can try again.</p>
        <div className="flex flex-col gap-2 sm:flex-row sm:justify-center">
          <button type="button" disabled={submitting} onClick={() => void retry(stage.order, stage.method)} className="min-h-11 cursor-pointer rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500 disabled:opacity-50">
            {submitting ? 'Starting…' : 'Try the payment again'}
          </button>
          <Link href="/" className="inline-flex min-h-11 items-center justify-center rounded-lg border border-line-strong px-5 text-sm font-semibold text-fg-strong hover:bg-hover">Back to the shop</Link>
        </div>
      </section>
    );
  }

  let body: ReactNode;
  if (!ready) {
    body = (
        <p role="status" className="py-10 text-center text-sm text-fg-muted">Checking your cart…</p>
    );
  } else if (cart.lines.length === 0) {
    body = (
        <div className="mx-auto max-w-md space-y-4 rounded-2xl border border-line bg-surface-raised p-10 text-center">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-sunken text-fg-subtle"><ShoppingBag className="h-7 w-7" aria-hidden="true" /></div>
          <h2 className="text-lg font-semibold text-fg-strong">Your cart is empty</h2>
          <p className="text-sm text-fg-muted">Add something from the shop to check out.</p>
          <Link href="/" className="inline-flex min-h-11 items-center rounded-lg bg-indigo-600 px-5 text-sm font-semibold text-white hover:bg-indigo-500">Continue shopping</Link>
        </div>
    );
  } else {
    body = (
        <CheckoutForm lines={cart.lines} defaultCountry={company.country} submitting={submitting} error={error} onSubmit={place} />
    );
  }

  return (
    <div className="space-y-6 pb-16">
      <header className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight text-fg-strong sm:text-3xl">Checkout</h1>
        <p className="text-sm text-fg-muted">Check your order, tell us where to send it, and pay securely.</p>
      </header>
      {body}
    </div>
  );
}
