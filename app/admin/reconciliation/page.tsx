import { listReconciliationLogsAction } from '@/server/domains/reconciliation/actions';
import { AdminReconciliationClient } from '@/components/admin/AdminReconciliationClient';

export default async function Page() {
  const logsPromise = listReconciliationLogsAction();
  return <AdminReconciliationClient logsPromise={logsPromise} />;
}
