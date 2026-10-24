import { Suspense } from 'react';
import { categoryAction } from '@/server/domains/vendors/prequal-actions';
import { CategoryEditorClient } from '@/components/admin/vendors/CategoryEditorClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => categoryAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the category" />}>
      <MissingAs404 result={view}>
        <CategoryEditorClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
