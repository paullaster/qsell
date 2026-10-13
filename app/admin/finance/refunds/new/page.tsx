import { NewRefundClient } from '@/components/admin/finance/NewRefundClient';
import { FinanceGate } from '@/components/admin/finance/gate';

export default async function AdminNewRefundPage({ searchParams }: { searchParams: Promise<{ customer?: string; source?: string }> }) {
  const { customer, source } = await searchParams;
  return (
    <FinanceGate>
      {async () => <NewRefundClient customerId={customer} sourceKey={source} />}
    </FinanceGate>
  );
}
