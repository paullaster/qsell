import { Suspense } from 'react';
import { landedCostsAction } from '@/server/domains/vendors/landed-cost-actions';
import { LandedCostListClient } from '@/components/admin/vendors/LandedCostListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = landedCostsAction();
  return (
    <Suspense fallback={<PageSkeleton label="landed costs" />}>
      <LandedCostListClient initialPromise={initial} />
    </Suspense>
  );
}
