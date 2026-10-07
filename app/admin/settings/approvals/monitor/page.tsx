import { getLookupsAction, listPendingAction } from '@/server/kernel/approvals/actions';
import { MonitorClient } from '@/components/admin/approvals/MonitorClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminApprovalMonitorPage() {
  const [result, lookups] = await Promise.all([listPendingAction(), getLookupsAction()]);
  if (!result.ok) return <ErrorNote message={result.error} />;
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <MonitorClient requests={result.data} people={lookups.data.users} />;
}
