import { receiptFormOptionsAction, searchCustomersForReceiptAction } from '@/server/domains/finance/receivables/actions';
import { NewReceiptClient } from '@/components/admin/finance/NewReceiptClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminNewReceiptPage({ searchParams }: { searchParams: Promise<{ customer?: string }> }) {
  const { customer } = await searchParams;
  return (
    <FinanceGate>
      {async () => {
        const res = await receiptFormOptionsAction();
        if (!res.ok) return <LoadFailed error={res.error} />;
        // Arriving from a customer's statement (?customer=<their number>): already chosen.
        const preset = customer ? await searchCustomersForReceiptAction(customer) : null;
        const match = preset && preset.ok ? (preset.data.find((c) => c.number === customer) ?? null) : null;
        return <NewReceiptClient options={res.data} presetCustomer={match} />;
      }}
    </FinanceGate>
  );
}
