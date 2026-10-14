import { Suspense } from 'react';
import { listReturnsAction } from '@/server/domains/returns/actions';
import { ReturnsClient } from '@/components/admin/finance/ReturnsClient';
import { PageSkeleton } from '@/components/admin/finance/ui';

/** Returns are about stock as much as money, so this page does not wait for the books to be set up. */
export default function AdminReturnsPage() {
  const initial = listReturnsAction('open');
  return (
    <Suspense fallback={<PageSkeleton label="returns" />}>
      <ReturnsClient initialPromise={initial} />
    </Suspense>
  );
}
