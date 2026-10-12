import { listAccountsAction } from '@/server/domains/finance/actions';
import { ChartOfAccountsClient } from '@/components/admin/finance/ChartOfAccountsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminChartOfAccountsPage() {
  return (
    <FinanceGate>
      {async (o) => {
        const res = await listAccountsAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <ChartOfAccountsClient accounts={res.data} can={o.can} />;
      }}
    </FinanceGate>
  );
}
