import { glEntriesAction } from '@/server/domains/finance/actions';
import { EntriesClient } from '@/components/admin/finance/EntriesClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminGlEntriesPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await glEntriesAction({});
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <EntriesClient initial={res.data} />;
      }}
    </FinanceGate>
  );
}
