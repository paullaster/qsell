import { listBranchesAction } from '@/server/domains/payments/actions';
import { BranchesModal } from '@/components/admin/settings/KraModeModals';

export default function InterceptedBranchesFromBranchModesPage() {
  return <BranchesModal branchesPromise={listBranchesAction()} />;
}
