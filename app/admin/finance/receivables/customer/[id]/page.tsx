import { notFound } from 'next/navigation';
import { canPermission } from '@/server/domains/access-control/guard';
import { customerStatementAction } from '@/server/domains/finance/receivables/actions';
import { CustomerStatementClient } from '@/components/admin/finance/CustomerStatementClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminCustomerLedgerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <FinanceGate>
      {async () => {
        const res = await customerStatementAction(id);
        if (!res.ok) {
          if (res.code === 'NOT_FOUND') notFound();
          return <LoadFailed error={res.error} />;
        }
        return <CustomerStatementClient initial={res.data} canReceive={await canPermission('receipts:create')} />;
      }}
    </FinanceGate>
  );
}
