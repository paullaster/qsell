import type { Metadata } from 'next';
import { Suspense } from 'react';
import { OrderRouteClient } from '@/components/admin/orders/OrderRouteClient';
import { MissingAs404 } from '@/components/ui/missing-record';
import { getOrderAction } from '@/server/domains/orders/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { canEditProductsAction } from '@/server/domains/catalog/actions';
import { parseOrderTarget } from '@/lib/order-links';

export const metadata: Metadata = { title: 'Order' };

/** One order as a page: the address of an order that was typed, pasted or reloaded. Opened from a link inside the admin it opens over that screen instead (the intercepted route beside this one). */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ invoice?: string | string[] }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const target = parseOrderTarget({ order: id, ...query });
  const order = target.orderId === null ? Promise.resolve(null) : getOrderAction(target.orderId).catch(() => null);
  return (
    <Suspense fallback={<p role="status" className="p-6 text-sm text-fg-muted">Opening the order…</p>}>
      <MissingAs404 result={order.then((o) => ({ ok: o !== null, code: 'ORDER_NOT_FOUND' }))}>
        <OrderRouteClient orderPromise={order} companyPromise={getCompanySettingsAction()} canEditProductsPromise={canEditProductsAction()} presentation="page" />
      </MissingAs404>
    </Suspense>
  );
}
