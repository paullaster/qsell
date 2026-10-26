import { Suspense } from 'react';
import { requisitionsAction } from '@/server/domains/vendors/requisition-actions';
import { RequisitionListClient } from '@/components/admin/vendors/RequisitionListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = requisitionsAction();
  return (
    <Suspense fallback={<PageSkeleton label="requisitions" />}>
      <RequisitionListClient initialPromise={initial} />
    </Suspense>
  );
}
