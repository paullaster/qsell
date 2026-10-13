import { notFound } from 'next/navigation';
import { refundDetailAction } from '@/server/domains/finance/refund-actions';
import { RefundDetailClient } from '@/components/admin/finance/RefundDetailClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminRefundPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <FinanceGate>
      {async () => {
        const res = await refundDetailAction(id);
        if (!res.ok) {
          if (res.code === 'NOT_FOUND') notFound();
          return <LoadFailed error={res.error} />;
        }
        return <RefundDetailClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
