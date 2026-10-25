import { Suspense } from 'react';
import { rfqListAction } from '@/server/domains/vendors/rfq-actions';
import { RfqListClient } from '@/components/admin/vendors/RfqListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = rfqListAction({});
  return (
    <Suspense fallback={<PageSkeleton label="requests for quotation" />}>
      <RfqListClient initialPromise={initial} />
    </Suspense>
  );
}
