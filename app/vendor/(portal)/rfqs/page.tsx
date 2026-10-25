import { Suspense } from 'react';
import { vendorRfqsAction } from '@/server/domains/vendors/rfq-portal-actions';
import { RfqsListClient } from '@/components/vendor/RfqsListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorRfqsPage() {
  const initial = vendorRfqsAction();
  return (
    <Suspense fallback={<PageSkeleton label="your requests" />}>
      <RfqsListClient initialPromise={initial} />
    </Suspense>
  );
}
