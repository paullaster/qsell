import { Suspense } from 'react';
import { runAction } from '@/server/domains/vendors/payment-run-actions';
import { PaymentRunClient } from '@/components/admin/vendors/PaymentRunClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => runAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the payment run" />}>
      <MissingAs404 result={view}>
        <PaymentRunClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
