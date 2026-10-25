import { Suspense } from 'react';
import { prequalDetailAction } from '@/server/domains/vendors/prequal-actions';
import { PrequalDetailClient } from '@/components/admin/vendors/PrequalDetailClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => prequalDetailAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the application" />}>
      <MissingAs404 result={view}>
        <PrequalDetailClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
