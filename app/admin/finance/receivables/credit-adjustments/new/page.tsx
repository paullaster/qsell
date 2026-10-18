import { creditAdjustmentStartAction } from '@/server/domains/finance/credit-adjustment-actions';
import { NewCreditAdjustmentClient } from '@/components/admin/finance/NewCreditAdjustmentClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page({ searchParams }: { searchParams: Promise<{ customer?: string; source?: string; kind?: string; currency?: string }> }) {
  const start = searchParams.then(({ customer, source, kind, currency }) => creditAdjustmentStartAction(customer, source, kind, currency));
  return (
    <FinancePage label="the credit adjustment form">
      <NewCreditAdjustmentClient startPromise={start} />
    </FinancePage>
  );
}
