import { Suspense } from 'react';
import { refundStartAction } from '@/server/domains/finance/refund-actions';
import { NewRefundClient } from '@/components/admin/finance/NewRefundClient';
import { FinanceGate } from '@/components/admin/finance/gate';
import { PageSkeleton } from '@/components/admin/finance/ui';

export default async function AdminNewRefundPage({ searchParams }: { searchParams: Promise<{ customer?: string; source?: string }> }) {
  const { customer, source } = await searchParams;
  return (
    <FinanceGate>
      {() => (
        <Suspense fallback={<PageSkeleton label="the refund form" />}>
          <NewRefundClient startPromise={refundStartAction(customer, source)} />
        </Suspense>
      )}
    </FinanceGate>
  );
}
