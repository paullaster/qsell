import { Suspense } from 'react';
import { portalOverviewAction } from '@/server/domains/vendors/portal-actions';
import { VendorDashboardClient } from '@/components/vendor/VendorDashboardClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorDashboardPage() {
  const overview = portalOverviewAction();
  return (
    <Suspense fallback={<PageSkeleton label="your dashboard" />}>
      <VendorDashboardClient overviewPromise={overview} />
    </Suspense>
  );
}
