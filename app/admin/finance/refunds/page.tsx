import { listRefundsAction, refundReportAction } from '@/server/domains/finance/refund-actions';
import { RefundsClient } from '@/components/admin/finance/RefundsClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const list = listRefundsAction();
  const report = refundReportAction();
  return (
    <FinancePage label="refunds">
      <RefundsClient initialPromise={list} reportPromise={report} />
    </FinancePage>
  );
}
