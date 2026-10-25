import { Suspense } from 'react';
import { vendorPaymentsAction } from '@/server/domains/vendors/payment-portal-actions';
import { PaymentsListClient } from '@/components/vendor/PaymentsListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorPaymentsPage() {
  const initial = vendorPaymentsAction();
  return (
    <Suspense fallback={<PageSkeleton label="your payments" />}>
      <PaymentsListClient initialPromise={initial} />
    </Suspense>
  );
}
