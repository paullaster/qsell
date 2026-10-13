import { bankStatementsOverviewAction } from '@/server/domains/finance/bank-statement-actions';
import { BankStatementsClient } from '@/components/admin/finance/BankStatementsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminBankStatementsPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await bankStatementsOverviewAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <BankStatementsClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
