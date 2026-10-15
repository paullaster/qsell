import { statementWorkbenchAction } from '@/server/domains/finance/bank-statement-actions';
import { StatementWorkbenchClient } from '@/components/admin/finance/StatementWorkbenchClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const view = params.then(({ accountId }) => statementWorkbenchAction(accountId));
  return (
    <FinancePage label="the statement">
      <StatementWorkbenchClient viewPromise={view} />
    </FinancePage>
  );
}
