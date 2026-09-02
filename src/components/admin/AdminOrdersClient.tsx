'use client';

import { useRouter } from 'next/navigation';
import { AdminOrders } from '@/components/admin/AdminOrders';
import type { Order } from '@/types/index';

export function AdminOrdersClient({ ordersPromise }: { ordersPromise: Promise<Order[]> }) {
  const router = useRouter();
  return <AdminOrders ordersPromise={ordersPromise} onRefresh={() => router.refresh()} />;
}
