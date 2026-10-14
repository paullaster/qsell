import { walletReportAction } from '@/server/domains/finance/wallet-actions';
import { WalletsClient } from '@/components/admin/finance/WalletsClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = walletReportAction();
  return (
    <FinancePage label="the wallet report">
      <WalletsClient viewPromise={view} />
    </FinancePage>
  );
}
