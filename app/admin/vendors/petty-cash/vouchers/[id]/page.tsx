import { Suspense } from 'react';
import { pettyVoucherAction } from '@/server/domains/vendors/petty-cash-actions';
import { PettyVoucherClient } from '@/components/admin/vendors/PettyVoucherClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => pettyVoucherAction(id, null));
  return (
    <Suspense fallback={<PageSkeleton label="the voucher" />}>
      <MissingAs404 result={view}>
        <PettyVoucherClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
