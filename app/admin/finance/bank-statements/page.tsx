import { bankStatementsOverviewAction } from '@/server/domains/finance/bank-statement-actions';
import { BankStatementsClient } from '@/components/admin/finance/BankStatementsClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = bankStatementsOverviewAction();
  return (
    <FinancePage label="bank statements">
      <BankStatementsClient viewPromise={view} />
    </FinancePage>
  );
}
