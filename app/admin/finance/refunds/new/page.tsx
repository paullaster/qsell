import { refundStartAction } from '@/server/domains/finance/refund-actions';
import { NewRefundClient } from '@/components/admin/finance/NewRefundClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page({ searchParams }: { searchParams: Promise<{ customer?: string; source?: string }> }) {
  const start = searchParams.then(({ customer, source }) => refundStartAction(customer, source));
  return (
    <FinancePage label="the refund form">
      <NewRefundClient startPromise={start} />
    </FinancePage>
  );
}
