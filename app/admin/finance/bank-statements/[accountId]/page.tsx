import { statementWorkbenchAction } from '@/server/domains/finance/bank-statement-actions';
import { StatementWorkbenchClient } from '@/components/admin/finance/StatementWorkbenchClient';
import { FinancePage } from '@/components/admin/finance/gate';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ accountId: string }> }) {
  const view = params.then(({ accountId }) => statementWorkbenchAction(accountId));
  return (
    <FinancePage label="the statement">
      <MissingAs404 result={view}>
        <StatementWorkbenchClient viewPromise={view} />
      </MissingAs404>
    </FinancePage>
  );
}
