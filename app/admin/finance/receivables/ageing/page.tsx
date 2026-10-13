import { receivablesAgeingAction } from '@/server/domains/finance/receivables/actions';
import { AgeingClient } from '@/components/admin/finance/AgeingClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminReceivablesAgeingPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await receivablesAgeingAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <AgeingClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
