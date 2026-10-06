import { getKraSettingsAction } from '@/server/domains/kra/actions';
import { KraBranchModesClient } from '@/components/admin/settings/KraModeClients';

export default async function AdminKraBranchModesPage() {
  const { branches, company } = await getKraSettingsAction();
  return (
    <KraBranchModesClient
      branches={branches}
      companyMode={company?.mode ?? null}
      companyModuleSigning={company?.moduleSigning ?? {}}
    />
  );
}
