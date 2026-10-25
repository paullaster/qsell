import { Suspense } from 'react';
import { notInvoicedAction } from '@/server/domains/vendors/rgn-actions';
import { NotInvoicedClient } from '@/components/admin/vendors/NotInvoicedClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const report = notInvoicedAction();
  return (
    <Suspense fallback={<PageSkeleton label="the report" />}>
      <NotInvoicedClient reportPromise={report} />
    </Suspense>
  );
}
