import { notFound } from 'next/navigation';
import { receiptDetailAction } from '@/server/domains/finance/receivables/actions';
import { ReceiptDetailClient } from '@/components/admin/finance/ReceiptDetailClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ posting_failed?: string }>;
}) {
  const { id } = await params;
  const { posting_failed } = await searchParams;
  return (
    <FinanceGate>
      {async () => {
        const res = await receiptDetailAction(id);
        if (!res.ok) {
          if (res.code === 'NOT_FOUND') notFound();
          return <LoadFailed error={res.error} />;
        }
        return <ReceiptDetailClient view={res.data} postingFailed={posting_failed} />;
      }}
    </FinanceGate>
  );
}
