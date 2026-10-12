import { listPaymentMethodsAction } from '@/server/domains/finance/receivables/actions';
import { PaymentMethodsClient } from '@/components/admin/finance/PaymentMethodsClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminPaymentMethodsPage() {
  return (
    <FinanceGate>
      {async () => {
        const res = await listPaymentMethodsAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        return <PaymentMethodsClient view={res.data} />;
      }}
    </FinanceGate>
  );
}
