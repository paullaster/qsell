import { listCreditAdjustmentsAction } from '@/server/domains/finance/credit-adjustment-actions';
import { CreditAdjustmentsClient } from '@/components/admin/finance/CreditAdjustmentsClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const list = listCreditAdjustmentsAction();
  return (
    <FinancePage label="credit adjustments">
      <CreditAdjustmentsClient initialPromise={list} />
    </FinancePage>
  );
}
