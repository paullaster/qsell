import { Suspense } from 'react';
import { contractAction } from '@/server/domains/vendors/contract-actions';
import { ContractClient } from '@/components/admin/vendors/ContractClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const view = contractAction(null);
  return (
    <Suspense fallback={<PageSkeleton label="the contract" />}>
      <ContractClient viewPromise={view} />
    </Suspense>
  );
}
