import { cashCountsOverviewAction } from '@/server/domains/finance/cash-count-actions';
import { CashCountsClient } from '@/components/admin/finance/CashCountsClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = cashCountsOverviewAction();
  return (
    <FinancePage label="cash counts">
      <CashCountsClient viewPromise={view} />
    </FinancePage>
  );
}
