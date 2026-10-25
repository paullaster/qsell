import { Suspense } from 'react';
import { vendorRfqAction } from '@/server/domains/vendors/rfq-portal-actions';
import { RfqDetailClient } from '@/components/vendor/RfqDetailClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorRfqPage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => vendorRfqAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the request" />}>
      <RfqDetailClient viewPromise={view} />
    </Suspense>
  );
}
