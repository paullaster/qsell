import { Suspense } from 'react';
import { paymentListAction } from '@/server/domains/vendors/payment-actions';
import { PaymentListClient } from '@/components/admin/vendors/PaymentListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = paymentListAction({});
  return (
    <Suspense fallback={<PageSkeleton label="payments" />}>
      <PaymentListClient initialPromise={initial} />
    </Suspense>
  );
}
