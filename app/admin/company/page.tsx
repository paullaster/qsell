import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { AdminCompanyClient } from '@/components/admin/AdminCompanyClient';

export default async function AdminCompanyPage() {
  const settingsPromise = getCompanySettingsAction();
  return <AdminCompanyClient settingsPromise={settingsPromise} />;
}
