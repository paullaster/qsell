import { Suspense } from 'react';
import { listReceiptsAction } from '@/server/domains/finance/receivables/actions';
import { ReceiptsClient } from '@/components/admin/finance/ReceiptsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function AdminReceiptsPage() {
  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="receipts" />}>
          <ReceiptsClient initialPromise={listReceiptsAction({})} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
