import { getLookupsAction, listWorkflowsAction } from '@/server/kernel/approvals/actions';
import { WorkflowListClient } from '@/components/admin/approvals/WorkflowListClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminApprovalWorkflowsPage() {
  const [list, lookups] = await Promise.all([listWorkflowsAction(), getLookupsAction()]);
  if (!list.ok) return <ErrorNote message={list.error} />;
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <WorkflowListClient workflows={list.data} lookups={lookups.data} />;
}
