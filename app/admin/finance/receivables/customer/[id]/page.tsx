import { canPermission } from '@/server/domains/access-control/guard';
import { customerStatementAction } from '@/server/domains/finance/receivables/actions';
import { customerWalletAction } from '@/server/domains/finance/wallet-actions';
import { CustomerStatementClient } from '@/components/admin/finance/CustomerStatementClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const statement = params.then(({ id }) => customerStatementAction(id));
  const wallet = params.then(({ id }) => customerWalletAction(id));
  const canReceive = canPermission('receipts:create');
  return (
    <FinancePage label="the customer's account">
      <CustomerStatementClient statementPromise={statement} walletPromise={wallet} canReceivePromise={canReceive} />
    </FinancePage>
  );
}
