import { AdminTransactionLedger } from '@/components/admin/AdminTransactionLedger';
import { listTransactionLedgerAction } from '@/server/domains/transactions/actions';

export default async function AdminTransactionLedgerPage() {
  const lines = await listTransactionLedgerAction();
  return <AdminTransactionLedger lines={lines} />;
}
