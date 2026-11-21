import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AccountSubpage } from '@/components/store/account/AccountSubpage';
import { OrderDetailClient } from '@/components/store/account/OrderDetailClient';
import { PaymentOnOrder } from '@/components/store/payment/PaymentOnOrder';
import { MissingAs404 } from '@/components/ui/missing-record';
import { myOrderAction } from '@/server/domains/customers/actions';

export const metadata: Metadata = { title: 'Complete your order', robots: { index: false, follow: false } };

/**
 * An order waiting for its payment, shown as it is (nothing on it can be changed here) with the two things a shopper can do: say they
 * already paid and give the provider's code, or pay again. The order is read beside the payment choices, not before them.
 */
export default function CompleteOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const result = params.then(({ id }) => myOrderAction(id));
  return (
    <AccountSubpage title="Complete your order" back={{ href: '/profile/orders', label: 'My orders' }}>
      <Suspense fallback={<p role="status" className="text-sm text-fg-muted">Loading your order…</p>}>
        <MissingAs404 result={result}>
          <div className="space-y-6">
            <PaymentOnOrder result={result} params={params} />
            <OrderDetailClient result={result} />
          </div>
        </MissingAs404>
      </Suspense>
    </AccountSubpage>
  );
}
