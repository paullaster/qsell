import { Suspense } from 'react';
import { paymentRulesAction } from '@/server/domains/vendors/payment-terms-actions';
import { PaymentRulesClient } from '@/components/admin/vendors/PaymentRulesClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = paymentRulesAction();
  return (
    <Suspense fallback={<PageSkeleton label="payment rules" />}>
      <PaymentRulesClient initialPromise={initial} />
    </Suspense>
  );
}
