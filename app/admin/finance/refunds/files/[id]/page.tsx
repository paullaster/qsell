import { refundFileDetailAction } from '@/server/domains/finance/refund-file-actions';
import { RefundFileDetailClient } from '@/components/admin/finance/RefundFileDetailClient';
import { FinancePage } from '@/components/admin/finance/gate';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => refundFileDetailAction(id));
  return (
    <FinancePage label="the payment file">
      <MissingAs404 result={view}>
        <RefundFileDetailClient viewPromise={view} />
      </MissingAs404>
    </FinancePage>
  );
}
