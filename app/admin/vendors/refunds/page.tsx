import { Suspense } from 'react';
import { refundsAction } from '@/server/domains/vendors/refund-actions';
import { RefundListClient } from '@/components/admin/vendors/RefundListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = refundsAction();
  return (
    <Suspense fallback={<PageSkeleton label="vendor refunds" />}>
      <RefundListClient initialPromise={initial} />
    </Suspense>
  );
}
