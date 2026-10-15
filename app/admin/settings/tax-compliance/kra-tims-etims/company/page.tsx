import { kraCompanyAction } from '@/server/domains/kra/actions';
import { KraCompanyModeClient } from '@/components/admin/settings/KraModeClients';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminKraCompanyModePage() {
  return (
    <SettingsFrame label="the company mode">
      <KraCompanyModeClient companyPromise={kraCompanyAction()} />
    </SettingsFrame>
  );
}
