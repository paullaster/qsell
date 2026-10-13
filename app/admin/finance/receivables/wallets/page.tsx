import { walletReportAction } from '@/server/domains/finance/wallet-actions';
import { WalletsClient } from '@/components/admin/finance/WalletsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminWalletsPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await walletReportAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <WalletsClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
