import { listReceiptsAction } from '@/server/domains/finance/receivables/actions';
import { ReceiptsClient } from '@/components/admin/finance/ReceiptsClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const initial = listReceiptsAction({});
  return (
    <FinancePage label="receipts">
      <ReceiptsClient initialPromise={initial} />
    </FinancePage>
  );
}
