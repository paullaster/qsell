'use client';

import { useRouter } from 'next/navigation';
import { AdminDashboard } from '@/components/admin/AdminDashboard';
import type { DashboardAnalytics } from '@/types/index';

export function AdminDashboardClient({
  analyticsPromise,
}: {
  analyticsPromise: Promise<DashboardAnalytics>;
}) {
  const router = useRouter();
  return (
    <AdminDashboard
      analyticsPromise={analyticsPromise}
      onNavigateTab={(tab) => {
        const map: Record<string, string> = {
          inventory: '/admin/inventory',
          gateways: '/admin/gateways',
          reconciliation: '/admin/reconciliation',
          orders: '/admin/orders',
        };
        router.push(map[tab] || '/admin');
      }}
    />
  );
}
