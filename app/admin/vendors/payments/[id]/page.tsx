import { Suspense } from 'react';
import { paymentAction } from '@/server/domains/vendors/payment-actions';
import { PaymentVoucherClient } from '@/components/admin/vendors/PaymentVoucherClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => paymentAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the payment" />}>
      <MissingAs404 result={view}>
        <PaymentVoucherClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
