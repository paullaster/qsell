'use client';

import { AdminOrders } from '@/components/admin/AdminOrders';
import { OrderFlowPanel } from '@/components/admin/orders/OrderFlowPanel';
import type { ordersPageAction } from '@/server/domains/orders/actions';
import type { PublicCompany } from '@/lib/company-view';

export function AdminOrdersClient({
  firstPage,
  companyPromise,
  canEditProductsPromise,
}: {
  firstPage: ReturnType<typeof ordersPageAction>;
  companyPromise: Promise<PublicCompany>;
  canEditProductsPromise: Promise<boolean>;
}) {
  return (
    <div className="space-y-4">
      <OrderFlowPanel />
      <AdminOrders firstPage={firstPage} companyPromise={companyPromise} canEditProductsPromise={canEditProductsPromise} />
    </div>
  );
}
