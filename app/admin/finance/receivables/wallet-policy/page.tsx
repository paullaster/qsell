import { creditPolicyAction } from '@/server/domains/finance/wallet-actions';
import { WalletPolicyClient } from '@/components/admin/finance/WalletPolicyClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = creditPolicyAction();
  return (
    <FinancePage label="the wallet policy">
      <WalletPolicyClient viewPromise={view} />
    </FinancePage>
  );
}
