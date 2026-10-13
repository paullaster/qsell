import { creditPolicyAction } from '@/server/domains/finance/wallet-actions';
import { WalletPolicyClient } from '@/components/admin/finance/WalletPolicyClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminWalletPolicyPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await creditPolicyAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <WalletPolicyClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
