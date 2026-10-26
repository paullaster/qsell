import { Suspense } from 'react';
import { listVendorsAction } from '@/server/domains/vendors/actions';
import { VendorsBrowseModal } from '@/components/admin/vendors/VendorsBrowseModal';

/** The same list, shown over the form that asked for it. */
export default function InterceptedVendorsBrowsePage() {
  return (
    <Suspense fallback={<p className="p-6 text-sm text-fg-muted">Loading…</p>}>
      <VendorsBrowseModal initialPromise={listVendorsAction({})} />
    </Suspense>
  );
}
