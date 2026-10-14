import { Suspense } from 'react';
import { bankStatementsOverviewAction } from '@/server/domains/finance/bank-statement-actions';
import { BankStatementsClient } from '@/components/admin/finance/BankStatementsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function Page() {

  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="bank statements" />}>
          <BankStatementsClient viewPromise={bankStatementsOverviewAction()} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
