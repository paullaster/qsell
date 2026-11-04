import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { Suspense } from 'react';
import { TrackingLoader } from '@/components/store/TrackingLoader';
import { getContainer } from '@/server/di/container';
import { clientAddress, waitMessage } from '@/lib/rate-limit';
import { isWellFormedTrackingToken } from '@/lib/tracking-token';
import { fingerprintSecret } from '@/server/domains/payments/crypto';

export const metadata: Metadata = { title: 'Track your order', robots: { index: false, follow: false } };
export const dynamic = 'force-dynamic';

/**
 * A customer's own tracking page, by the link in their message. The link is looked up and limited by address and by link before
 * anything is shown (a security decision, so it is awaited); what is shown is read after, with the page already on its way.
 */
export default async function TrackPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!isWellFormedTrackingToken(token)) notFound();
  const c = getContainer();
  const h = await headers();
  const byAddress = await c.rateLimits.hit('tracking_ip', clientAddress(h.get('x-real-ip'), h.get('x-forwarded-for')));
  // The limit is kept by a fingerprint of the link, never by the link itself.
  const byLink = await c.rateLimits.hit('tracking_token', fingerprintSecret(token).slice(0, 24));
  if (!byAddress.allowed || !byLink.allowed) {
    return (
      <main className="mx-auto max-w-2xl space-y-3 px-4 py-10">
        <h1 className="text-xl font-bold text-fg-strong">Please wait a moment</h1>
        <p role="alert" className="text-sm text-fg">
          {waitMessage(Math.max(byAddress.retryAfterSeconds, byLink.retryAfterSeconds))}
        </p>
      </main>
    );
  }
  const link = await c.trackingLinks.resolve(token);
  if (link === null) notFound();
  // The order's data is not awaited here: it streams in behind the heading.
  const order = c.trackedOrders.forOrder(link.companyId, link.orderId);
  return (
    <main className="mx-auto max-w-2xl px-4 py-8">
      <h1 className="mb-2 text-sm font-semibold tracking-wider text-indigo-600 uppercase dark:text-indigo-400">Track your order</h1>
      <Suspense
        fallback={
          <p role="status" className="text-sm text-fg-muted">
            Looking up your order…
          </p>
        }
      >
        <TrackingLoader order={order} />
      </Suspense>
    </main>
  );
}
