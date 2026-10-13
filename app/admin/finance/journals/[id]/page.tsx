import { notFound } from 'next/navigation';
import { getBatchAction } from '@/server/domains/finance/actions';
import { JournalEditorClient } from '@/components/admin/finance/JournalEditorClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminJournalBatchPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <FinanceGate>
      {async () => {
        const res = await getBatchAction(id);
        if (!res.ok) {
          if (res.code === 'NOT_FOUND') notFound();
          return <LoadFailed error={res.error} />;
        }
        return <JournalEditorClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
