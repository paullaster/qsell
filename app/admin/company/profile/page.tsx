import { companyProfileAction } from '@/server/domains/company/actions';
import { CompanyProfileClient } from '@/components/admin/company/CompanyProfileClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminCompanyProfilePage() {
  // Nothing is awaited here: the screen draws at once and the profile fills it in when it arrives.
  return (
    <SettingsFrame label="the company profile">
      <CompanyProfileClient profilePromise={companyProfileAction()} />
    </SettingsFrame>
  );
}
