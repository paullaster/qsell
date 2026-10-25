import { Suspense } from 'react';
import { invoiceAction } from '@/server/domains/vendors/invoice-actions';
import { InvoiceWorkspaceClient } from '@/components/admin/vendors/InvoiceWorkspaceClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => invoiceAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the invoice" />}>
      <MissingAs404 result={view}>
        <InvoiceWorkspaceClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
