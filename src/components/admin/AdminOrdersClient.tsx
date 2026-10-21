'use client';

import { AdminOrders } from '@/components/admin/AdminOrders';
import type { ordersPageAction } from '@/server/domains/orders/actions';
import type { PublicCompany } from '@/lib/company-view';

export function AdminOrdersClient({
  firstPage,
  companyPromise,
}: {
  firstPage: ReturnType<typeof ordersPageAction>;
  companyPromise: Promise<PublicCompany>;
}) {
  return <AdminOrders firstPage={firstPage} companyPromise={companyPromise} />;
}
