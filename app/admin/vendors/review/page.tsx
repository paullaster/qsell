import { Suspense } from 'react';
import { reviewQueueAction } from '@/server/domains/vendors/admin-actions';
import { ReviewQueueClient } from '@/components/admin/vendors/ReviewQueueClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = reviewQueueAction();
  return (
    <Suspense fallback={<PageSkeleton label="the review queue" />}>
      <ReviewQueueClient initialPromise={initial} />
    </Suspense>
  );
}
