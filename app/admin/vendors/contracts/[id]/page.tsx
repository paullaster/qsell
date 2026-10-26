import { Suspense } from 'react';
import { contractAction } from '@/server/domains/vendors/contract-actions';
import { ContractClient } from '@/components/admin/vendors/ContractClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => contractAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the contract" />}>
      <MissingAs404 result={view}>
        <ContractClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
