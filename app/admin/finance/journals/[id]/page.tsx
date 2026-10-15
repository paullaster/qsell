import { getBatchAction } from '@/server/domains/finance/actions';
import { JournalEditorClient } from '@/components/admin/finance/JournalEditorClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => getBatchAction(id));
  return (
    <FinancePage label="the journal batch">
      <JournalEditorClient viewPromise={view} />
    </FinancePage>
  );
}
