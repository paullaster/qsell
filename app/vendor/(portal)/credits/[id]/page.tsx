import { Suspense } from 'react';
import { vendorCreditAction } from '@/server/domains/vendors/credit-memo-portal-actions';
import { CreditDetailClient } from '@/components/vendor/CreditDetailClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => vendorCreditAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the credit note" />}>
      <CreditDetailClient viewPromise={view} />
    </Suspense>
  );
}
