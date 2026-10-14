import { Suspense } from 'react';
import { statementWorkbenchAction } from '@/server/domains/finance/bank-statement-actions';
import { StatementWorkbenchClient } from '@/components/admin/finance/StatementWorkbenchClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default async function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="the statement" />}>
          <StatementWorkbenchClient viewPromise={statementWorkbenchAction(accountId)} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
