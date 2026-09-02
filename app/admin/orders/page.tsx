import { listOrdersAction } from '@/server/domains/orders/actions';
import { AdminOrdersClient } from '@/components/admin/AdminOrdersClient';

export default async function Page() {
  const ordersPromise = listOrdersAction();
  return <AdminOrdersClient ordersPromise={ordersPromise} />;
}
