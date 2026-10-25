import { Suspense } from 'react';
import { vendorInvoiceAction } from '@/server/domains/vendors/invoice-portal-actions';
import { InvoiceDetailClient } from '@/components/vendor/InvoiceDetailClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorInvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => vendorInvoiceAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the invoice" />}>
      <InvoiceDetailClient viewPromise={view} />
    </Suspense>
  );
}
