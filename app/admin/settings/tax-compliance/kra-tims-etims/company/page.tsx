import { getKraSettingsAction } from '@/server/domains/kra/actions';
import { KraCompanyModeClient } from '@/components/admin/settings/KraModeClients';

export default async function AdminKraCompanyModePage() {
  const { company } = await getKraSettingsAction();
  return <KraCompanyModeClient initial={company} />;
}
