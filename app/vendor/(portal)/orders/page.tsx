import { Suspense } from 'react';
import { vendorOrdersAction } from '@/server/domains/vendors/po-portal-actions';
import { OrdersListClient } from '@/components/vendor/OrdersListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorOrdersPage() {
  const initial = vendorOrdersAction();
  return (
    <Suspense fallback={<PageSkeleton label="your orders" />}>
      <OrdersListClient initialPromise={initial} />
    </Suspense>
  );
}
