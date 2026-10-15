import { groupsPageAction, peoplePageAction } from '@/server/kernel/approvals/actions';
import { ApproversClient } from '@/components/admin/approvals/ApproversClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminApproversPage() {
  // Both lists start now; each shows when it arrives.
  return (
    <SettingsFrame label="approvers">
      <ApproversClient peoplePromise={peoplePageAction({})} groupsPromise={groupsPageAction({})} />
    </SettingsFrame>
  );
}
