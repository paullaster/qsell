import { redirect } from 'next/navigation';
import { ordersPageAction } from '@/server/domains/orders/actions';
import { AdminOrdersClient } from '@/components/admin/AdminOrdersClient';
import { invoiceHref, orderHref, parseOrderTarget } from '@/lib/order-links';

export default async function Page({ searchParams }: { searchParams: Promise<{ order?: string | string[]; invoice?: string | string[] }> }) {
  // An older link named one order in the address (`?order=`): it goes to that order's own address.
  const { orderId, invoice } = parseOrderTarget(await searchParams);
  if (orderId !== null) redirect(invoice ? invoiceHref(orderId) : orderHref(orderId));
  // Nothing else is awaited here: the first page of orders starts at once, and the screen draws at once.
  return <AdminOrdersClient firstPage={ordersPageAction({})} />;
}
