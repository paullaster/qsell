import { Suspense } from 'react';
import { rgnAction } from '@/server/domains/vendors/rgn-actions';
import { RgnEditorClient } from '@/components/admin/vendors/RgnEditorClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => rgnAction(id, null));
  return (
    <Suspense fallback={<PageSkeleton label="the note" />}>
      <MissingAs404 result={view}>
        <RgnEditorClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
