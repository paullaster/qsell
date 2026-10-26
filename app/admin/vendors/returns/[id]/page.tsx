import { Suspense } from 'react';
import { returnAction } from '@/server/domains/vendors/purchase-return-actions';
import { ReturnClient } from '@/components/admin/vendors/ReturnClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => returnAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the return" />}>
      <MissingAs404 result={view}>
        <ReturnClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
