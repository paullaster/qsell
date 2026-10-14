import { Suspense } from 'react';
import { returnDetailAction } from '@/server/domains/returns/actions';
import { ReturnDetailClient } from '@/components/admin/finance/ReturnDetailClient';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default async function AdminReturnPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return (
    <Suspense fallback={<PageSkeleton label="the return" />}>
      <ReturnDetailClient viewPromise={returnDetailAction(id)} />
    </Suspense>
  );
}
