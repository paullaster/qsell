import { salesPostingOverviewAction } from '@/server/domains/finance/sales-actions';
import { SalesPostingClient } from '@/components/admin/finance/SalesPostingClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = salesPostingOverviewAction();
  return (
    <FinancePage label="sales posting">
      <SalesPostingClient viewPromise={view} />
    </FinancePage>
  );
}
