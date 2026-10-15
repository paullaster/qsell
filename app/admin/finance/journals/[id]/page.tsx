import { getBatchAction } from '@/server/domains/finance/actions';
import { JournalEditorClient } from '@/components/admin/finance/JournalEditorClient';
import { FinancePage } from '@/components/admin/finance/gate';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => getBatchAction(id));
  return (
    <FinancePage label="the journal batch">
      <MissingAs404 result={view}>
        <JournalEditorClient viewPromise={view} />
      </MissingAs404>
    </FinancePage>
  );
}
