import { Suspense } from 'react';
import { vendorOrderAction } from '@/server/domains/vendors/po-portal-actions';
import { OrderDetailClient } from '@/components/vendor/OrderDetailClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => vendorOrderAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the order" />}>
      <OrderDetailClient viewPromise={view} />
    </Suspense>
  );
}
