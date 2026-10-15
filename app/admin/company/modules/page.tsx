import { companyModulesAction } from '@/server/domains/company/actions';
import { CompanyModulesClient } from '@/components/admin/company/CompanyModulesClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminCompanyModulesPage() {
  return (
    <SettingsFrame label="the module names">
      <CompanyModulesClient labelsPromise={companyModulesAction()} />
    </SettingsFrame>
  );
}
