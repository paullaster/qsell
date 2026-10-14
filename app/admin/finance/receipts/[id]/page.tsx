import { Suspense } from 'react';
import { receiptDetailAction } from '@/server/domains/finance/receivables/actions';
import { ReceiptDetailClient } from '@/components/admin/finance/ReceiptDetailClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default async function AdminReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ posting_failed?: string }>;
}) {
  const { id } = await params;
  const { posting_failed: postingFailed } = await searchParams;
  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="the receipt" />}>
          <ReceiptDetailClient viewPromise={receiptDetailAction(id)} postingFailed={postingFailed} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
