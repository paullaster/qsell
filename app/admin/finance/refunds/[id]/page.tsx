import { refundDetailAction } from '@/server/domains/finance/refund-actions';
import { RefundDetailClient } from '@/components/admin/finance/RefundDetailClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => refundDetailAction(id));
  return (
    <FinancePage label="the refund">
      <RefundDetailClient viewPromise={view} />
    </FinancePage>
  );
}
