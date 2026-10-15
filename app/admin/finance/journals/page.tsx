import { canPermission } from '@/server/domains/access-control/guard';
import { listBatchesAction } from '@/server/domains/finance/actions';
import { JournalBatchesClient } from '@/components/admin/finance/JournalBatchesClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const batches = listBatchesAction();
  const canCreate = canPermission('journal_batches:create');
  return (
    <FinancePage label="journals">
      <JournalBatchesClient batchesPromise={batches} canCreatePromise={canCreate} />
    </FinancePage>
  );
}
