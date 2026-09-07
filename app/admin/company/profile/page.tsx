import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { AdminCompanyClient } from '@/components/admin/AdminCompanyClient';

export default async function AdminCompanyProfilePage() {
  const settingsPromise = getCompanySettingsAction();
  return <AdminCompanyClient settingsPromise={settingsPromise} section="profile" />;
}
