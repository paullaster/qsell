import { listOrdersAction } from '@/server/domains/orders/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { AdminOrdersClient } from '@/components/admin/AdminOrdersClient';

export default async function Page() {
  const ordersPromise = listOrdersAction();
  const companyPromise = getCompanySettingsAction();
  return (
    <AdminOrdersClient ordersPromise={ordersPromise} companyPromise={companyPromise} />
  );
}
