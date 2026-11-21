import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AccountSubpage } from '@/components/store/account/AccountSubpage';
import { OrderDetailClient } from '@/components/store/account/OrderDetailClient';
import { MissingAs404 } from '@/components/ui/missing-record';
import { myOrderAction, myOrderTrackingAction, myOrderVisitsAction } from '@/server/domains/customers/actions';

export const metadata: Metadata = { title: 'Order', robots: { index: false, follow: false } };

export default function OrderPage({ params }: { params: Promise<{ id: string }> }) {
  const result = params.then(({ id }) => myOrderAction(id));
  // Where the delivery stands is read beside the order, not before it: the order shows at once.
  const tracking = params.then(({ id }) => myOrderTrackingAction(id));
  const visits = params.then(({ id }) => myOrderVisitsAction(id));
  return (
    <AccountSubpage title="Order details" back={{ href: '/profile/orders', label: 'My orders' }}>
      <Suspense
        fallback={
          <p role="status" className="text-sm text-fg-muted">
            Loading your order…
          </p>
        }
      >
        <MissingAs404 result={result}>
          <OrderDetailClient result={result} tracking={tracking} visits={visits} payPrompt />
        </MissingAs404>
      </Suspense>
    </AccountSubpage>
  );
}
