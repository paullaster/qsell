import { canPermission } from '@/server/domains/access-control/guard';
import { listFiscalAction } from '@/server/domains/finance/actions';
import { PeriodsClient } from '@/components/admin/finance/PeriodsClient';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const years = listFiscalAction();
  const canEdit = canPermission('fiscal_calendar:edit');
  return (
    <FinancePage label="fiscal periods">
      <PeriodsClient yearsPromise={years} canEditPromise={canEdit} thisYear={Number(businessDate().slice(0, 4))} />
    </FinancePage>
  );
}
