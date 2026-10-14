import { billsOverviewAction } from '@/server/domains/payments/bill-actions';
import { BillsClient } from '@/components/admin/payments/BillsClient';
import { LoadFailed } from '@/components/admin/finance/ui';

export default async function AdminBillsPage() {
  const res = await billsOverviewAction();
  if (!res.ok) return <LoadFailed error={res.error} />;
  return <BillsClient initial={res.data} />;
}
