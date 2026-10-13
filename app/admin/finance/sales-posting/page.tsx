import { salesPostingOverviewAction } from '@/server/domains/finance/sales-actions';
import { SalesPostingClient } from '@/components/admin/finance/SalesPostingClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminSalesPostingPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await salesPostingOverviewAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <SalesPostingClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
