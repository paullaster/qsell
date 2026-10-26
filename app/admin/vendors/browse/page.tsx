import type { Metadata } from 'next';
import { Suspense } from 'react';
import { listVendorsAction } from '@/server/domains/vendors/actions';
import { VendorsClient } from '@/components/admin/vendors/VendorsClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export const metadata: Metadata = { title: 'All vendors' };

/** The whole list on its own address, so a form that picks a vendor can offer "View all" without leaving the form (see the intercepted copy). */
export default function Page() {
  const initial = listVendorsAction({});
  return (
    <Suspense fallback={<PageSkeleton label="vendors" />}>
      <VendorsClient initialPromise={initial} />
    </Suspense>
  );
}
