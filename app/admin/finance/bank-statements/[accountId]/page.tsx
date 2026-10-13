import { notFound } from 'next/navigation';
import { statementWorkbenchAction } from '@/server/domains/finance/bank-statement-actions';
import { StatementWorkbenchClient } from '@/components/admin/finance/StatementWorkbenchClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminBankStatementAccountPage({ params }: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await params;
  return (
    <FinanceGate>
      {async () => {
        const res = await statementWorkbenchAction(accountId);
        if (!res.ok) {
          if (res.code === 'ACCOUNT_NOT_FOUND') notFound();
          return <LoadFailed error={res.error} />;
        }
        return <StatementWorkbenchClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
