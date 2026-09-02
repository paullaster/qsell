'use client';

import { useRouter } from 'next/navigation';
import { AdminOrders } from '@/components/admin/AdminOrders';
import type { Order } from '@/types/index';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';

export function AdminOrdersClient({
  ordersPromise,
  companyPromise,
}: {
  ordersPromise: Promise<Order[]>;
  companyPromise: Promise<CompanySettingsRow>;
}) {
  const router = useRouter();
  return (
    <AdminOrders
      ordersPromise={ordersPromise}
      companyPromise={companyPromise}
      onRefresh={() => router.refresh()}
    />
  );
}
