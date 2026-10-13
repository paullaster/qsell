import { registersAction } from '@/server/domains/finance/actions';
import { RegistersClient } from '@/components/admin/finance/RegistersClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminRegistersPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await registersAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <RegistersClient registers={res.data.registers} canReverse={res.data.canReverse} />;
      }}
    </FinanceGate>
  );
}
