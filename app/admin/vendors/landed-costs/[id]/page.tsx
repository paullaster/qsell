import { Suspense } from 'react';
import { landedCostAction } from '@/server/domains/vendors/landed-cost-actions';
import { LandedCostClient } from '@/components/admin/vendors/LandedCostClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => landedCostAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the charge" />}>
      <MissingAs404 result={view}>
        <LandedCostClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
