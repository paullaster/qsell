import { postingSetupAction } from '@/server/domains/finance/actions';
import { PostingSetupClient } from '@/components/admin/finance/PostingSetupClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = postingSetupAction();
  return (
    <FinancePage label="posting setup">
      <PostingSetupClient viewPromise={view} />
    </FinancePage>
  );
}
