import { glEntriesAction } from '@/server/domains/finance/actions';
import { EntriesClient } from '@/components/admin/finance/EntriesClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const initial = glEntriesAction({});
  return (
    <FinancePage label="ledger entries">
      <EntriesClient initialPromise={initial} />
    </FinancePage>
  );
}
