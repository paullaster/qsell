import { companyAppearanceAction } from '@/server/domains/company/actions';
import { CompanyAppearanceClient } from '@/components/admin/company/CompanyAppearanceClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminCompanyAppearancePage() {
  return (
    <SettingsFrame label="the appearance settings">
      <CompanyAppearanceClient appearancePromise={companyAppearanceAction()} />
    </SettingsFrame>
  );
}
