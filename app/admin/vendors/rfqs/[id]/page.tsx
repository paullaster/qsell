import { Suspense } from 'react';
import { rfqAction } from '@/server/domains/vendors/rfq-actions';
import { RfqEditorClient } from '@/components/admin/vendors/RfqEditorClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => rfqAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the request" />}>
      <MissingAs404 result={view}>
        <RfqEditorClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
