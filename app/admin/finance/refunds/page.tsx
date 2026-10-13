import { listRefundsAction, refundReportAction } from '@/server/domains/finance/refund-actions';
import { RefundsClient } from '@/components/admin/finance/RefundsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminRefundsPage() {
  return (
    <FinanceGate>
      {async () => {
        const to = new Date().toISOString().slice(0, 10);
        const from = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
        const [list, report] = await Promise.all([listRefundsAction(), refundReportAction(from, to)]);
        if (!list.ok) return <LoadFailed error={list.error} />;
        return <RefundsClient initial={list.data} report={report.ok ? report.data : null} from={from} to={to} />;
      }}
    </FinanceGate>
  );
}
