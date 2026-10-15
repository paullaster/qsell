import { receivablesAgeingAction } from '@/server/domains/finance/receivables/actions';
import { AgeingClient } from '@/components/admin/finance/AgeingClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = receivablesAgeingAction();
  return (
    <FinancePage label="receivables ageing">
      <AgeingClient viewPromise={view} />
    </FinancePage>
  );
}
