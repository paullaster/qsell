import { branchesPageAction } from '@/server/domains/branches/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { AdminBranchesClient } from '@/components/admin/settings/AdminBranchesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminBranchesPage() {
  const firstPage = branchesPageAction({});
  const canManage = canPermission('branches:manage');
  return (
    <SettingsFrame label="branches">
      <AdminBranchesClient firstPage={firstPage} canManage={canManage} />
    </SettingsFrame>
  );
}
