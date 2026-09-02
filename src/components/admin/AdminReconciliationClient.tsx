'use client';

import { useRouter } from 'next/navigation';
import { AdminReconciliation } from '@/components/admin/AdminReconciliation';
import type { ReconciliationLog } from '@/types/index';

export function AdminReconciliationClient({
  logsPromise,
}: {
  logsPromise: Promise<ReconciliationLog[]>;
}) {
  const router = useRouter();
  return (
    <AdminReconciliation
      reconciliationLogsPromise={logsPromise}
      onRefresh={() => router.refresh()}
    />
  );
}
