import { refundDetailAction } from '@/server/domains/finance/refund-actions';
import { RefundDetailClient } from '@/components/admin/finance/RefundDetailClient';
import { FinancePage } from '@/components/admin/finance/gate';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => refundDetailAction(id));
  return (
    <FinancePage label="the refund">
      <MissingAs404 result={view}>
        <RefundDetailClient viewPromise={view} />
      </MissingAs404>
    </FinancePage>
  );
}
