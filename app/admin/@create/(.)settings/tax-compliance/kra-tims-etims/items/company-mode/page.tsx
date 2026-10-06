import { getKraSettingsAction } from '@/server/domains/kra/actions';
import { CompanyModeModal } from '@/components/admin/settings/KraModeModals';

export default async function InterceptedCompanyModePage() {
  const { company } = await getKraSettingsAction();
  return <CompanyModeModal initial={company} />;
}
