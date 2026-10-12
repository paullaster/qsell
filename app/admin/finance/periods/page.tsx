import { canPermission } from '@/server/domains/access-control/guard';
import { listFiscalAction } from '@/server/domains/finance/actions';
import { PeriodsClient } from '@/components/admin/finance/PeriodsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminFiscalPeriodsPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await listFiscalAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <PeriodsClient years={res.data} canEdit={await canPermission('fiscal_calendar:edit')} />;
      }}
    </FinanceGate>
  );
}
