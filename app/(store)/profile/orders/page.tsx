import { Suspense } from 'react';
import type { Metadata } from 'next';
import { AccountSubpage } from '@/components/store/account/AccountSubpage';
import { OrdersClient } from '@/components/store/account/OrdersClient';
import { myOrdersPageAction } from '@/server/domains/customers/actions';

export const metadata: Metadata = { title: 'My orders', robots: { index: false, follow: false } };

export default function OrdersPage() {
  const firstPage = myOrdersPageAction({});
  return (
    <AccountSubpage title="My orders" intro="Follow your orders and see what you bought.">
      <Suspense
        fallback={
          <p role="status" className="text-sm text-fg-muted">
            Loading your orders…
          </p>
        }
      >
        <OrdersClient firstPage={firstPage} />
      </Suspense>
    </AccountSubpage>
  );
}
