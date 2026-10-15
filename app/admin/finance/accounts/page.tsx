import { listAccountsPageAction } from '@/server/domains/finance/actions';
import { ChartOfAccountsClient } from '@/components/admin/finance/ChartOfAccountsClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const first = listAccountsPageAction({});
  return (
    <FinancePage label="the chart of accounts">
      {(overview) => <ChartOfAccountsClient firstPage={first} can={overview.can} />}
    </FinancePage>
  );
}
