import { Suspense } from 'react';
import { contractsAction } from '@/server/domains/vendors/contract-actions';
import { ContractListClient } from '@/components/admin/vendors/ContractListClient';
import { PageSkeleton } from '@/components/ui/screen-kit';

export default function Page() {
  const initial = contractsAction();
  return (
    <Suspense fallback={<PageSkeleton label="contracts" />}>
      <ContractListClient initialPromise={initial} />
    </Suspense>
  );
}
