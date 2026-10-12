import { listBankAccountsAction } from '@/server/domains/finance/receivables/actions';
import { BankAccountsClient } from '@/components/admin/finance/BankAccountsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminBankAccountsPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await listBankAccountsAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <BankAccountsClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
