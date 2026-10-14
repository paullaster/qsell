import { Suspense } from 'react';
import { creditPolicyAction } from '@/server/domains/finance/wallet-actions';
import { WalletPolicyClient } from '@/components/admin/finance/WalletPolicyClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function Page() {

  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="the wallet policy" />}>
          <WalletPolicyClient viewPromise={creditPolicyAction()} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
