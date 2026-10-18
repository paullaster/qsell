import { creditAdjustmentDetailAction } from '@/server/domains/finance/credit-adjustment-actions';
import { CreditAdjustmentDetailClient } from '@/components/admin/finance/CreditAdjustmentDetailClient';
import { FinancePage } from '@/components/admin/finance/gate';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => creditAdjustmentDetailAction(id));
  return (
    <FinancePage label="the credit adjustment">
      <MissingAs404 result={view}>
        <CreditAdjustmentDetailClient viewPromise={view} />
      </MissingAs404>
    </FinancePage>
  );
}
