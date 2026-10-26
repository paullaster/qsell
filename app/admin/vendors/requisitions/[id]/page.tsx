import { Suspense } from 'react';
import { requisitionAction } from '@/server/domains/vendors/requisition-actions';
import { RequisitionClient } from '@/components/admin/vendors/RequisitionClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => requisitionAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the requisition" />}>
      <MissingAs404 result={view}>
        <RequisitionClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
