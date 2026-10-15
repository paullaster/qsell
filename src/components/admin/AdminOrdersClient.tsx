'use client';

import { useRouter } from 'next/navigation';
import { AdminOrders } from '@/components/admin/AdminOrders';
import type { Order } from '@/types/index';
import type { PublicCompany } from '@/lib/company-view';

export function AdminOrdersClient({
  ordersPromise,
  companyPromise,
}: {
  ordersPromise: Promise<Order[]>;
  companyPromise: Promise<PublicCompany>;
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
