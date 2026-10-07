import { notFound } from 'next/navigation';
import { getLookupsAction, getWorkflowAction } from '@/server/kernel/approvals/actions';
import { WorkflowDesignerClient } from '@/components/admin/approvals/WorkflowDesignerClient';
import { ErrorNote } from '@/components/admin/approvals/ErrorNote';

export default async function AdminApprovalWorkflowPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [workflow, lookups] = await Promise.all([getWorkflowAction(id), getLookupsAction()]);
  if (!workflow.ok) {
    if (workflow.code === 'NOT_FOUND') notFound();
    return <ErrorNote message={workflow.error} />;
  }
  if (!lookups.ok) return <ErrorNote message={lookups.error} />;
  return <WorkflowDesignerClient workflow={workflow.data} lookups={lookups.data} />;
}
