import { Suspense } from 'react';
import { creditMemoAction } from '@/server/domains/vendors/credit-memo-actions';
import { CreditWorkspaceClient } from '@/components/admin/vendors/CreditWorkspaceClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function Page({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => creditMemoAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the credit memo" />}>
      <MissingAs404 result={view}>
        <CreditWorkspaceClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
