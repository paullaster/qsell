import { getWorkflowAction } from '@/server/kernel/approvals/actions';
import { WorkflowDesignerClient } from '@/components/admin/approvals/WorkflowDesignerClient';
import { SettingsFrame } from '@/components/admin/settings/frame';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function AdminApprovalWorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  const workflow = params.then(({ id }) => getWorkflowAction(id));
  return (
    <SettingsFrame label="the workflow">
      <MissingAs404 result={workflow}>
        <WorkflowDesignerClient workflowPromise={workflow} />
      </MissingAs404>
    </SettingsFrame>
  );
}
