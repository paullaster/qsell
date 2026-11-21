import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import { TrackedPayment } from '@/components/store/payment/TrackedPayment';
import { getContainer } from '@/server/di/container';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { isWellFormedTrackingToken } from '@/lib/tracking-token';
import { toCustomerOrder, type CustomerOrder } from '@/lib/storefront-account';
import { fingerprintSecret } from '@/server/domains/payments/crypto';
import type { AccountResult } from '@/server/domains/customers/actions';

export const metadata: Metadata = { title: 'Complete your order', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * Finishing the payment of an order from the link in the shopper's own message. The link is looked up and limited before anything is
 * shown (a security decision, so it is awaited); the order is read after, and shown as it is: nothing on it can be changed here.
 */
export default async function CompleteTrackedOrderPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isWellFormedTrackingToken(token)) notFound();
  const c = getContainer();
  const h = await headers();
  const byAddress = await c.rateLimits.hit('tracking_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
  const byLink = await c.rateLimits.hit('tracking_token', fingerprintSecret(token).slice(0, 24));
  if (!byAddress.allowed || !byLink.allowed) {
    return (
      <main className="mx-auto max-w-2xl space-y-3 px-4 py-10">
        <h1 className="text-xl font-bold text-fg-strong">Please wait a moment</h1>
        <p role="alert" className="text-sm text-fg">{waitMessage(Math.max(byAddress.retryAfterSeconds, byLink.retryAfterSeconds))}</p>
      </main>
    );
  }
  const link = await c.trackingLinks.resolve(token);
  if (link === null) notFound();
  const result: Promise<AccountResult<CustomerOrder>> = c.orders.getById(link.orderId).then((order) => (order ? { ok: true, data: toCustomerOrder(order) } : { ok: false, error: 'This order was not found.' }));
  return (
    <main className="mx-auto max-w-2xl space-y-6 px-4 py-8">
      <h1 className="text-sm font-semibold tracking-wider text-indigo-600 uppercase dark:text-indigo-400">Complete your order</h1>
      <Suspense fallback={<p role="status" className="text-sm text-fg-muted">Looking up your order…</p>}>
        <TrackedPayment result={result} token={token} />
      </Suspense>
    </main>
  );
}
