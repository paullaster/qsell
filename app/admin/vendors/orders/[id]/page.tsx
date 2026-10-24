import { Suspense } from 'react';
import { poAction } from '@/server/domains/vendors/po-actions';
import { PoEditorClient } from '@/components/admin/vendors/PoEditorClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';
import { businessDate } from '@/server/kernel/numbering/business-date';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => poAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the order" />}>
      <MissingAs404 result={view}>
        <PoEditorClient viewPromise={view} today={businessDate()} />
      </MissingAs404>
    </Suspense>
  );
}
