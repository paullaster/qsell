import { Suspense } from 'react';
import { rgnListAction } from '@/server/domains/vendors/rgn-actions';
import { RgnListClient } from '@/components/admin/vendors/RgnListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = rgnListAction({});
  return (
    <Suspense fallback={<PageSkeleton label="received goods" />}>
      <RgnListClient initialPromise={initial} />
    </Suspense>
  );
}
