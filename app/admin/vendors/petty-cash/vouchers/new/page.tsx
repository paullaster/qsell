import { Suspense } from 'react';
import { pettyVoucherAction } from '@/server/domains/vendors/petty-cash-actions';
import { PettyVoucherClient } from '@/components/admin/vendors/PettyVoucherClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page({ searchParams }: { searchParams: Promise<{ float?: string }> }) {
  const view = searchParams.then(({ float }) => pettyVoucherAction(null, typeof float === 'string' ? float : null));
  return (
    <Suspense fallback={<PageSkeleton label="the voucher" />}>
      <PettyVoucherClient viewPromise={view} />
    </Suspense>
  );
}
