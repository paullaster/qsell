import { listBankAccountsAction } from '@/server/domains/finance/receivables/actions';
import { BankAccountsClient } from '@/components/admin/finance/BankAccountsClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = listBankAccountsAction();
  return (
    <FinancePage label="bank accounts">
      <BankAccountsClient viewPromise={view} />
    </FinancePage>
  );
}
