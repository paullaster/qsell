import { pendingCountsAction, pendingPageAction } from '@/server/kernel/approvals/actions';
import { MonitorClient } from '@/components/admin/approvals/MonitorClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminApprovalMonitorPage() {
  return (
    <SettingsFrame label="the approval monitor">
      <MonitorClient firstPage={pendingPageAction({})} counts={pendingCountsAction()} />
    </SettingsFrame>
  );
}
