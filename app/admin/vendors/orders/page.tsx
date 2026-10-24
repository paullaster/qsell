import { Suspense } from 'react';
import { poListAction } from '@/server/domains/vendors/po-actions';
import { PoListClient } from '@/components/admin/vendors/PoListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = poListAction({});
  return (
    <Suspense fallback={<PageSkeleton label="purchase orders" />}>
      <PoListClient initialPromise={initial} />
    </Suspense>
  );
}
