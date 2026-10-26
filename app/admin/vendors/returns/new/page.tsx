import { Suspense } from 'react';
import { returnableAction } from '@/server/domains/vendors/purchase-return-actions';
import { ReturnEditorClient } from '@/components/admin/vendors/ReturnEditorClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ searchParams }: { searchParams: Promise<{ rgn?: string }> }) {
  const view = searchParams.then(({ rgn }) => returnableAction(typeof rgn === 'string' ? rgn : ''));
  return (
    <Suspense fallback={<PageSkeleton label="the return" />}>
      <MissingAs404 result={view}>
        <ReturnEditorClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
