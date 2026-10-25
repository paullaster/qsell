import { Suspense } from 'react';
import { statementAction } from '@/server/domains/vendors/payment-actions';
import { VendorStatementClient } from '@/components/admin/vendors/VendorStatementClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ vendorId: string }> }) {
  const view = params.then(({ vendorId }) => statementAction(vendorId));
  return (
    <Suspense fallback={<PageSkeleton label="the statement" />}>
      <MissingAs404 result={view}>
        <VendorStatementClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
