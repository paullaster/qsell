import { Suspense } from 'react';
import { stockCountAction } from '@/server/domains/stock/count-actions';
import { CountDetailClient } from '@/components/admin/stock/CountDetailClient';
import { PageSkeleton } from '@/components/ui/screen-kit';
import { MissingAs404 } from '@/components/ui/missing-record';

export default function StockCountPage({ params }: { params: Promise<{ id: string }> }) {
  const view = params.then(({ id }) => stockCountAction(id));
  return (
    <Suspense fallback={<PageSkeleton label="the count" />}>
      <MissingAs404 result={view}>
        <CountDetailClient viewPromise={view} />
      </MissingAs404>
    </Suspense>
  );
}
