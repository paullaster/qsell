import { Suspense } from 'react';
import { listRefundsAction, refundReportAction } from '@/server/domains/finance/refund-actions';
import { RefundsClient } from '@/components/admin/finance/RefundsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function AdminRefundsPage() {
  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="refunds" />}>
          <RefundsClient initialPromise={listRefundsAction()} reportPromise={refundReportAction()} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
