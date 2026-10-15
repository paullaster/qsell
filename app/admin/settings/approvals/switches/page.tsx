import { branchSwitchesPageAction, companySwitchesAction } from '@/server/kernel/approvals/actions';
import { SwitchesClient } from '@/components/admin/approvals/SwitchesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminApprovalSwitchesPage() {
  return (
    <SettingsFrame label="the approval switches">
      <SwitchesClient companyPromise={companySwitchesAction()} branchPromise={branchSwitchesPageAction({})} />
    </SettingsFrame>
  );
}
