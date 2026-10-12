import { listReceiptsAction } from '@/server/domains/finance/receivables/actions';
import { ReceiptsClient } from '@/components/admin/finance/ReceiptsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminReceiptsPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await listReceiptsAction({});
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <ReceiptsClient initial={res.data} />;
      }}
    </FinanceGate>
  );
}
