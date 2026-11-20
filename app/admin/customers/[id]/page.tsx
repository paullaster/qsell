import { canPermission } from '@/server/domains/access-control/guard';
import { CustomerCenterClient } from '@/components/admin/CustomerCenterClient';
import { customerCardAction } from '@/server/domains/customers/manage-actions';
import { customerStatementAction } from '@/server/domains/finance/receivables/actions';
import { customerWalletAction } from '@/server/domains/finance/wallet-actions';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { MissingAs404 } from '@/components/ui/missing-record';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cardPromise = customerCardAction(id);
  const [canReadStatement, canReadWallet] = await Promise.all([
    canPermission('customer_ledger:read'),
    canPermission('wallet:read'),
  ]);

  return (
    <SettingsFrame label="customer">
      <MissingAs404 result={cardPromise}>
        <CustomerCenterClient
          cardPromise={cardPromise}
          statementPromise={canReadStatement ? customerStatementAction(id) : null}
          walletPromise={canReadWallet ? customerWalletAction(id) : null}
          canEditPromise={canPermission('customers:update')}
          canReceivePromise={canPermission('receipts:create')}
          canReadReceiptsPromise={canPermission('receipts:read')}
          canReadOrdersPromise={canPermission('orders:read')}
          canReadRefundsPromise={canPermission('refunds:read')}
        />
      </MissingAs404>
    </SettingsFrame>
  );
}
