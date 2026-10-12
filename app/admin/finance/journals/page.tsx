import { canPermission } from '@/server/domains/access-control/guard';
import { listBatchesAction } from '@/server/domains/finance/actions';
import { JournalBatchesClient } from '@/components/admin/finance/JournalBatchesClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminJournalsPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await listBatchesAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <JournalBatchesClient batches={res.data} canCreate={await canPermission('journal_batches:create')} />;
      }}
    </FinanceGate>
  );
}
