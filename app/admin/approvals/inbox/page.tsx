import { inboxCountsAction, inboxPageAction } from '@/server/kernel/approvals/actions';
import { ApprovalInboxClient } from '@/components/admin/approvals/ApprovalInboxClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminApprovalsInboxPage() {
  // Nothing is awaited here: the first page and the counts start together and fill the screen in as they arrive.
  return (
    <SettingsFrame label="your approvals">
      <ApprovalInboxClient firstPage={inboxPageAction({})} counts={inboxCountsAction()} />
    </SettingsFrame>
  );
}
