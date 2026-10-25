import { Suspense } from 'react';
import { commitmentsAction } from '@/server/domains/vendors/insights-actions';
import { VendorReportsClient } from '@/components/admin/vendors/VendorReportsClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = commitmentsAction();
  return (
    <Suspense fallback={<PageSkeleton label="vendor reports" />}>
      <VendorReportsClient commitmentsPromise={initial} />
    </Suspense>
  );
}
