import { Suspense } from 'react';
import { canPermission } from '@/server/domains/access-control/guard';
import { customerStatementAction } from '@/server/domains/finance/receivables/actions';
import { customerWalletAction } from '@/server/domains/finance/wallet-actions';
import { CustomerStatementClient } from '@/components/admin/finance/CustomerStatementClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default async function AdminCustomerLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="the customer's account" />}>
          <CustomerStatementClient statementPromise={customerStatementAction(id)} walletPromise={customerWalletAction(id)} canReceivePromise={canPermission('receipts:create')} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
