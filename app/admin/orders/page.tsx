import { getOrderAction, ordersPageAction } from '@/server/domains/orders/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { canEditProductsAction } from '@/server/domains/catalog/actions';
import { AdminOrdersClient } from '@/components/admin/AdminOrdersClient';
import { parseOrderTarget } from '@/lib/order-links';

export default function Page({ searchParams }: { searchParams: Promise<{ order?: string | string[]; invoice?: string | string[] }> }) {
  // Nothing is awaited here: the first page of orders and the company details start together, and the screen draws at once.
  // A link from another screen (a receipt, say) names one order, and its invoice, to open: that order is read in the same way.
  const target = searchParams.then(async (params) => {
    const { orderId, invoice } = parseOrderTarget(params);
    const order = orderId === null ? null : await getOrderAction(orderId).catch(() => null);
    return { order, invoice, missing: orderId !== null && order === null };
  });
  return (
    <AdminOrdersClient
      firstPage={ordersPageAction({})}
      companyPromise={getCompanySettingsAction()}
      canEditProductsPromise={canEditProductsAction()}
      targetPromise={target}
    />
  );
}
