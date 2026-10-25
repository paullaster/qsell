import { Suspense } from 'react';
import { vendorInvoicesAction } from '@/server/domains/vendors/invoice-portal-actions';
import { InvoicesListClient } from '@/components/vendor/InvoicesListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorInvoicesPage() {
  const initial = vendorInvoicesAction();
  return (
    <Suspense fallback={<PageSkeleton label="your invoices" />}>
      <InvoicesListClient initialPromise={initial} />
    </Suspense>
  );
}
