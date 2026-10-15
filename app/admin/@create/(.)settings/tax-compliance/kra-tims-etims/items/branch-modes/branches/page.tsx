import { branchesPageAction } from '@/server/domains/branches/actions';
import { canPermission } from '@/server/domains/access-control/guard';
import { BranchesModal } from '@/components/admin/settings/KraModeModals';

export default function InterceptedBranchesFromBranchModesPage() {
  return <BranchesModal firstPage={branchesPageAction({})} canManage={canPermission('branches:manage')} />;
}
