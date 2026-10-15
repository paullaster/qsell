import { workflowsPageAction } from '@/server/kernel/approvals/actions';
import { WorkflowListClient } from '@/components/admin/approvals/WorkflowListClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminApprovalWorkflowsPage() {
  return (
    <SettingsFrame label="approval workflows">
      <WorkflowListClient firstPage={workflowsPageAction({})} />
    </SettingsFrame>
  );
}
