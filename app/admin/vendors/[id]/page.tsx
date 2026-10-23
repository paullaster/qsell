import { Suspense } from 'react';
import { vendorDetailAction } from '@/server/domains/vendors/actions';
import { VendorDetailClient } from '@/components/admin/vendors/VendorDetailClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => vendorDetailAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the vendor" />}>
      <MissingAs404 result={view}>
        <VendorDetailClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
