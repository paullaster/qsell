import { Suspense } from 'react';
import { walletReportAction } from '@/server/domains/finance/wallet-actions';
import { WalletsClient } from '@/components/admin/finance/WalletsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function Page() {

  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="the wallet report" />}>
          <WalletsClient viewPromise={walletReportAction()} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
