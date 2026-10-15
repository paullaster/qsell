import { myRequestsPageAction } from '@/server/kernel/approvals/actions';
import { MyRequestsClient } from '@/components/admin/approvals/MyRequestsClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminMyApprovalRequestsPage() {
  return (
    <SettingsFrame label="your requests">
      <MyRequestsClient firstPage={myRequestsPageAction({})} />
    </SettingsFrame>
  );
}
