'use client';

import { useRouter } from 'next/navigation';
import type { KraBranchSettingsView, KraConfigView } from '@/server/domains/kra/actions';
import { RouteModal } from '@/components/admin/RouteModal';
import type { ModuleSigning } from '@/server/domains/kra/signing/types';
import type { BranchRow } from '@/server/db/drizzle/schema';
import { AdminBranchesClient } from './AdminBranchesClient';
import { KraBranchModesClient, KraCompanyModeClient } from './KraModeClients';

const ITEMS_PATH = '/admin/settings/tax-compliance/kra-tims-etims/items';

/*
 * Intercepted versions of the Company Mode and Branch Modes screens, opened from the eTIMS
 * items page. The save actions revalidate the KRA settings paths, so the page behind the
 * dialog already shows the new state by the time it closes.
 */

export function CompanyModeModal({ initial }: { initial: KraConfigView | null }) {
  const router = useRouter();
  const close = () => router.back();
  return (
    <RouteModal title="Company mode" onClose={close}>
      <KraCompanyModeClient embedded initial={initial} onSaved={close} />
    </RouteModal>
  );
}

export function BranchModesModal({
  branches,
  companyMode,
  companyModuleSigning,
}: {
  branches: KraBranchSettingsView[];
  companyMode: 'tims' | 'etims' | null;
  companyModuleSigning: ModuleSigning;
}) {
  const router = useRouter();
  return (
    // Stays open after a save: there can be several branches to configure.
    <RouteModal title="Branch modes" onClose={() => router.back()}>
      <KraBranchModesClient
        embedded
        branches={branches}
        companyMode={companyMode}
        companyModuleSigning={companyModuleSigning}
        branchesHref={`${ITEMS_PATH}/branch-modes/branches`}
      />
    </RouteModal>
  );
}

/**
 * The Branches screen as a dialog, opened from the Branch Modes dialog. Closing it goes back
 * to the Branch Modes dialog, whose data is refreshed by the branch actions' revalidation.
 */
export function BranchesModal({ branchesPromise }: { branchesPromise: Promise<BranchRow[]> }) {
  const router = useRouter();
  return (
    <RouteModal title="Branches" onClose={() => router.back()}>
      <AdminBranchesClient branchesPromise={branchesPromise} embedded />
    </RouteModal>
  );
}
