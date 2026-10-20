'use client';

import { Suspense } from 'react';
import { useRouter } from 'next/navigation';
import type { unitsPageAction } from '@/server/domains/units/actions';
import { AdminUnitsClient } from '@/components/admin/settings/AdminUnitsClient';
import { RouteModal } from '@/components/admin/RouteModal';

/** The whole unit list over the screen the person was on, so a long list is browsed without leaving the product form. */
export function UnitsBrowseModal({
  firstPage,
  canManage,
}: {
  firstPage: ReturnType<typeof unitsPageAction>;
  canManage: Promise<boolean>;
}) {
  const router = useRouter();
  return (
    <RouteModal title="Units of measure" onClose={() => router.back()}>
      <Suspense
        fallback={
          <p role="status" className="text-sm text-fg-muted">
            Loading…
          </p>
        }
      >
        <AdminUnitsClient firstPage={firstPage} canManage={canManage} />
      </Suspense>
    </RouteModal>
  );
}
