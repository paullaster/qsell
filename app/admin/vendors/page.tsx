import { Suspense } from 'react';
import { listVendorsAction } from '@/server/domains/vendors/actions';
import { VendorsClient } from '@/components/admin/vendors/VendorsClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = listVendorsAction({});
  return (
    <Suspense fallback={<PageSkeleton label="vendors" />}>
      <VendorsClient initialPromise={initial} />
    </Suspense>
  );
}
