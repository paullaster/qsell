import { Suspense } from 'react';
import { billsOverviewAction } from '@/server/domains/payments/bill-actions';
import { BillsClient } from '@/components/admin/payments/BillsClient';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function AdminBillsPage() {
  return (
    <Suspense fallback={<PageSkeleton label="Bill Manager" />}>
      <BillsClient initialPromise={billsOverviewAction()} />
    </Suspense>
  );
}
