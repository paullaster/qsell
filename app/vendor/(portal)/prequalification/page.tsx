import { Suspense } from 'react';
import { prequalOverviewAction } from '@/server/domains/vendors/prequal-portal-actions';
import { PrequalOverviewClient } from '@/components/vendor/PrequalOverviewClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorPrequalificationPage() {
  const view = prequalOverviewAction();
  return (
    <Suspense fallback={<PageSkeleton label="prequalification" />}>
      <PrequalOverviewClient viewPromise={view} />
    </Suspense>
  );
}
