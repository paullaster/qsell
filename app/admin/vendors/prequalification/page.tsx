import { Suspense } from 'react';
import { prequalQueueAction } from '@/server/domains/vendors/prequal-actions';
import { PrequalQueueClient } from '@/components/admin/vendors/PrequalQueueClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = prequalQueueAction({});
  return (
    <Suspense fallback={<PageSkeleton label="applications" />}>
      <PrequalQueueClient initialPromise={initial} />
    </Suspense>
  );
}
