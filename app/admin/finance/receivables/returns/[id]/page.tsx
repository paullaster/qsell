import { Suspense } from 'react';
import { returnDetailAction } from '@/server/domains/returns/actions';
import { ReturnDetailClient } from '@/components/admin/finance/ReturnDetailClient';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default function AdminReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => returnDetailAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the return" />}>
      <ReturnDetailClient viewPromise={view} />
    </Suspense>
  );
}
