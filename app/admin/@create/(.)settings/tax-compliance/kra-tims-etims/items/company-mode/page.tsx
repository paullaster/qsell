import { kraCompanyAction } from '@/server/domains/kra/actions';
import { CompanyModeModal } from '@/components/admin/settings/KraModeModals';

export default function InterceptedCompanyModePage() {
  return <CompanyModeModal companyPromise={kraCompanyAction()} />;
}
