import { companyBannersAction } from '@/server/domains/company/actions';
import { AdminCompanyBannersClient } from '@/components/admin/AdminCompanyBannersClient';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminCompanyBannersPage() {
  return (
    <SettingsFrame label="the banners">
      <AdminCompanyBannersClient bannersPromise={companyBannersAction()} />
    </SettingsFrame>
  );
}
