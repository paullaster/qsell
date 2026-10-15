import { kraBranchesPageAction, kraCompanyAction } from '@/server/domains/kra/actions';
import { KraBranchModesClient } from '@/components/admin/settings/KraModeClients';
import { SettingsFrame } from '@/components/admin/settings/frame';

export default function AdminKraBranchModesPage() {
  return (
    <SettingsFrame label="the branch modes">
      <KraBranchModesClient companyPromise={kraCompanyAction()} firstPage={kraBranchesPageAction({})} />
    </SettingsFrame>
  );
}
