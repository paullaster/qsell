import { postingSetupAction } from '@/server/domains/finance/actions';
import { PostingSetupClient } from '@/components/admin/finance/PostingSetupClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminPostingSetupPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await postingSetupAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <PostingSetupClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
