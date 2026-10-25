import { Suspense } from 'react';
import { invoiceableOrdersAction } from '@/server/domains/vendors/invoice-portal-actions';
import { InvoiceStartClient } from '@/components/vendor/InvoiceStartClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function VendorNewInvoicePage() {
  const orders = invoiceableOrdersAction();
  return (
    <Suspense fallback={<PageSkeleton label="your orders" />}>
      <InvoiceStartClient ordersPromise={orders} />
    </Suspense>
  );
}
