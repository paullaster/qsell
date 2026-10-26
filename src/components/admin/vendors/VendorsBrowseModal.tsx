'use client';

import { useRouter } from 'next/navigation';
import { RouteModal } from '@/components/admin/RouteModal';
import type { listVendorsAction } from '@/server/domains/vendors/actions';
import { VendorsClient } from './VendorsClient';

/** Every vendor, in a window over the screen that asked ("View all" on a vendor picker). */
export function VendorsBrowseModal({ initialPromise }: { initialPromise: ReturnType<typeof listVendorsAction> }) {
  const router = useRouter();
  return (
    <RouteModal title="All vendors" onClose={() => router.back()}>
      <VendorsClient initialPromise={initialPromise} />
    </RouteModal>
  );
}
