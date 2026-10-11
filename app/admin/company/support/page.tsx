import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { AdminCompanySupportClient } from '@/components/admin/AdminCompanySupportClient';

export default async function AdminCompanySupportPage() {
  const settingsPromise = getCompanySettingsAction();
  return <AdminCompanySupportClient settingsPromise={settingsPromise} />;
}
