import { Suspense } from 'react';
import { refundDetailAction } from '@/server/domains/finance/refund-actions';
import { RefundDetailClient } from '@/components/admin/finance/RefundDetailClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default async function AdminRefundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="the refund" />}>
          <RefundDetailClient viewPromise={refundDetailAction(id)} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
