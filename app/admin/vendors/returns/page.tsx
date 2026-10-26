import { Suspense } from 'react';
import { returnsAction } from '@/server/domains/vendors/purchase-return-actions';
import { ReturnListClient } from '@/components/admin/vendors/ReturnListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = returnsAction();
  return (
    <Suspense fallback={<PageSkeleton label="returns to vendors" />}>
      <ReturnListClient initialPromise={initial} />
    </Suspense>
  );
}
