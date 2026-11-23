import { Suspense } from 'react';
import { OrderRouteClient } from '@/components/admin/orders/OrderRouteClient';
import { getOrderAction } from '@/server/domains/orders/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { canEditProductsAction } from '@/server/domains/catalog/actions';
import { parseOrderTarget } from '@/lib/order-links';

/** The same order, intercepted: opened over the screen the person was on, and closing it returns there. */
export default async function Page({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ invoice?: string | string[] }> }) {
  const [{ id }, query] = await Promise.all([params, searchParams]);
  const target = parseOrderTarget({ order: id, ...query });
  const order = target.orderId === null ? Promise.resolve(null) : getOrderAction(target.orderId).catch(() => null);
  return (
    <Suspense fallback={<p role="status" className="fixed inset-x-0 top-24 z-50 mx-auto w-fit rounded-xl border border-line bg-surface-raised p-4 text-sm text-fg-muted shadow-xl">Opening the order…</p>}>
      <OrderRouteClient orderPromise={order} companyPromise={getCompanySettingsAction()} canEditProductsPromise={canEditProductsAction()} presentation="modal" />
    </Suspense>
  );
}
