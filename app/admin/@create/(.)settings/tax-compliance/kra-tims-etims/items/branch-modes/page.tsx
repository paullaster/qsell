import { kraBranchesPageAction, kraCompanyAction } from '@/server/domains/kra/actions';
import { BranchModesModal } from '@/components/admin/settings/KraModeModals';

export default function InterceptedBranchModesPage() {
  return <BranchModesModal companyPromise={kraCompanyAction()} firstPage={kraBranchesPageAction({})} />;
}
