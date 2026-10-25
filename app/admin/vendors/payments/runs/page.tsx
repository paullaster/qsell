import { Suspense } from 'react';
import { runListAction } from '@/server/domains/vendors/payment-run-actions';
import { PaymentRunListClient } from '@/components/admin/vendors/PaymentRunListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = runListAction({});
  return (
    <Suspense fallback={<PageSkeleton label="payment runs" />}>
      <PaymentRunListClient initialPromise={initial} />
    </Suspense>
  );
}
