import { getWorkflowAction } from '@/server/kernel/approvals/actions';
import { WorkflowDesignerClient } from '@/components/admin/approvals/WorkflowDesignerClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminApprovalWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const workflow = params.then(({ id }) => getWorkflowAction(id));
  return (
    <SettingsFrame label="the workflow">
      <WorkflowDesignerClient workflowPromise={workflow} />
    </SettingsFrame>
  );
}
