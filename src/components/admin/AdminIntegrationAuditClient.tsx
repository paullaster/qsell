'use client';

import { useRouter } from 'next/navigation';
import { AdminIntegrationAudit } from '@/components/admin/AdminIntegrationAudit';

export function AdminIntegrationAuditClient({
  logsPromise,
}: {
  logsPromise: Promise<{
    data: any[];
    total: number;
    page: number;
    pageSize: number;
  }>;
}) {
  const router = useRouter();
  return (
    <AdminIntegrationAudit
      logsPromise={logsPromise}
      onRefresh={() => router.refresh()}
    />
  );
}