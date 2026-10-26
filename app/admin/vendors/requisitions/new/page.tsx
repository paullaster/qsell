import { Suspense } from 'react';
import { requisitionAction } from '@/server/domains/vendors/requisition-actions';
import { RequisitionClient } from '@/components/admin/vendors/RequisitionClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const view = requisitionAction(null);
  return (
    <Suspense fallback={<PageSkeleton label="the requisition" />}>
      <RequisitionClient viewPromise={view} />
    </Suspense>
  );
}
