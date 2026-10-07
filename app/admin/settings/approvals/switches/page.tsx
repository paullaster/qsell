import { getLookupsAction, listSwitchesAction } from '@/server/kernel/approvals/actions';
import { SwitchesClient } from '@/components/admin/approvals/SwitchesClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminApprovalSwitchesPage() {
  const [switches, lookups] = await Promise.all([listSwitchesAction(), getLookupsAction()]);
  if (!switches.ok) return <ErrorNote message={switches.error} />;
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <SwitchesClient switches={switches.data} lookups={lookups.data} />;
}
