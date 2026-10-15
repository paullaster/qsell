import { Suspense } from 'react';
import { paymentActivityAction } from '@/server/domains/payments/activity-actions';
import { PaymentActivityClient } from '@/components/admin/payments/PaymentActivityClient';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function AdminPaymentActivityPage() {
  return (
    <Suspense fallback={<PageSkeleton label="payment activity" />}>
      <PaymentActivityClient initialPromise={paymentActivityAction()} />
    </Suspense>
  );
}
