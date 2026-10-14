import { Suspense } from 'react';
import { listBankAccountsAction } from '@/server/domains/finance/receivables/actions';
import { BankAccountsClient } from '@/components/admin/finance/BankAccountsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function Page() {

  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="bank accounts" />}>
          <BankAccountsClient viewPromise={listBankAccountsAction()} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
