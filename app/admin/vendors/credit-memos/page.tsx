import { Suspense } from 'react';
import { creditQueueAction } from '@/server/domains/vendors/credit-memo-actions';
import { CreditQueueClient } from '@/components/admin/vendors/CreditQueueClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = creditQueueAction({});
  return (
    <Suspense fallback={<PageSkeleton label="credit memos" />}>
      <CreditQueueClient initialPromise={initial} />
    </Suspense>
  );
}
