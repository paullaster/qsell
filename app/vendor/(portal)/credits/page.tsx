import { Suspense } from 'react';
import { vendorCreditsAction } from '@/server/domains/vendors/credit-memo-portal-actions';
import { CreditsListClient } from '@/components/vendor/CreditsListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = vendorCreditsAction();
  return (
    <Suspense fallback={<PageSkeleton label="your credit notes" />}>
      <CreditsListClient initialPromise={initial} />
    </Suspense>
  );
}
