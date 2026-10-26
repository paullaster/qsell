import { Suspense } from 'react';
import { refundAction } from '@/server/domains/vendors/refund-actions';
import { RefundClient } from '@/components/admin/vendors/RefundClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => refundAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the refund" />}>
      <MissingAs404 result={view}>
        <RefundClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
