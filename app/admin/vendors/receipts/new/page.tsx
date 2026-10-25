import { Suspense } from 'react';
import { rgnAction } from '@/server/domains/vendors/rgn-actions';
import { RgnEditorClient } from '@/components/admin/vendors/RgnEditorClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ searchParams }: { searchParams: Promise<{ po?: string }> }) {
  const view = searchParams.then(({ po }) => rgnAction(null, po ?? null));
  return (
    <Suspense fallback={<PageSkeleton label="the delivery" />}>
      <MissingAs404 result={view}>
        <RgnEditorClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
