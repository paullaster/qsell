'use client';

import { Suspense } from 'react';
import { useRouter } from 'next/navigation';
import type { kraBranchesPageAction, kraCompanyAction } from '@/server/domains/kra/actions';
import type { branchesPageAction } from '@/server/domains/branches/actions';
import { RouteModal } from '@/components/admin/RouteModal';
import { AdminBranchesClient } from './AdminBranchesClient';
import { KraBranchModesClient, KraCompanyModeClient } from './KraModeClients';

const ITEMS_PATH = '/admin/settings/tax-compliance/kra-tims-etims/items';

/*
 * Intercepted versions of the Company Mode and Branch Modes screens, opened from the eTIMS
 * items page. The save actions revalidate the KRA settings paths, so the page behind the
 * dialog already shows the new state by the time it closes.
 */

const loading = (what: string) => (
  <p role="status" className="text-sm text-fg-muted">
    Loading {what}…
  </p>
);

export function CompanyModeModal({ companyPromise }: { companyPromise: ReturnType<typeof kraCompanyAction> }) {
  const router = useRouter();
  const close = () => router.back();
  return (
    <RouteModal title="Company mode" onClose={close}>
      <Suspense fallback={loading('the company mode')}>
        <KraCompanyModeClient embedded companyPromise={companyPromise} onSaved={close} />
      </Suspense>
    </RouteModal>
  );
}

export function BranchModesModal({ companyPromise, firstPage }: { companyPromise: ReturnType<typeof kraCompanyAction>; firstPage: ReturnType<typeof kraBranchesPageAction> }) {
  const router = useRouter();
  return (
    // Stays open after a save: there can be several branches to configure.
    <RouteModal title="Branch modes" onClose={() => router.back()}>
      <Suspense fallback={loading('the branch modes')}>
        <KraBranchModesClient embedded companyPromise={companyPromise} firstPage={firstPage} branchesHref={`${ITEMS_PATH}/branch-modes/branches`} />
      </Suspense>
    </RouteModal>
  );
}

/**
 * The Branches screen as a dialog, opened from the Branch Modes dialog. Closing it goes back
 * to the Branch Modes dialog, whose data is refreshed by the branch actions' revalidation.
 */
export function BranchesModal({ firstPage, canManage }: { firstPage: ReturnType<typeof branchesPageAction>; canManage: Promise<boolean> }) {
  const router = useRouter();
  return (
    <RouteModal title="Branches" onClose={() => router.back()}>
      <Suspense fallback={loading('branches')}>
        <AdminBranchesClient firstPage={firstPage} canManage={canManage} embedded />
      </Suspense>
    </RouteModal>
  );
}
