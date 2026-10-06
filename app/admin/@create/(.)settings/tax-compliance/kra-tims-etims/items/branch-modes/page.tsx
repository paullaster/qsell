import { getKraSettingsAction } from '@/server/domains/kra/actions';
import { BranchModesModal } from '@/components/admin/settings/KraModeModals';

export default async function InterceptedBranchModesPage() {
  const { branches, company } = await getKraSettingsAction();
  return (
    <BranchModesModal
      branches={branches}
      companyMode={company?.mode ?? null}
      companyModuleSigning={company?.moduleSigning ?? {}}
    />
  );
}
