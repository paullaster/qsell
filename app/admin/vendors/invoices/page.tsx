import { Suspense } from 'react';
import { invoiceQueueAction } from '@/server/domains/vendors/invoice-actions';
import { InvoiceQueueClient } from '@/components/admin/vendors/InvoiceQueueClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = invoiceQueueAction({});
  return (
    <Suspense fallback={<PageSkeleton label="supplier invoices" />}>
      <InvoiceQueueClient initialPromise={initial} />
    </Suspense>
  );
}
