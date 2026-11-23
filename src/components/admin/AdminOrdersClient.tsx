'use client';

import { AdminOrders } from '@/components/admin/AdminOrders';
import { OrderFlowPanel } from '@/components/admin/orders/OrderFlowPanel';
import type { ordersPageAction } from '@/server/domains/orders/actions';

export function AdminOrdersClient({ firstPage }: { firstPage: ReturnType<typeof ordersPageAction> }) {
  return (
    <div className="space-y-4">
      <OrderFlowPanel />
      <AdminOrders firstPage={firstPage} />
    </div>
  );
}
