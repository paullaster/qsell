import { refundLimitsAction } from '@/server/domains/finance/refund-actions';
import { RefundLimitsClient } from '@/components/admin/finance/RefundLimitsClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = refundLimitsAction();
  return (
    <FinancePage label="the refund limits">
      <RefundLimitsClient viewPromise={view} />
    </FinancePage>
  );
}
