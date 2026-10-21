import { ordersPageAction } from '@/server/domains/orders/actions';
import { getCompanySettingsAction } from '@/server/domains/company/actions';
import { AdminOrdersClient } from '@/components/admin/AdminOrdersClient';

export default function Page() {
  // Nothing is awaited here: the first page of orders and the company details start together, and the screen draws at once.
  return (
    <AdminOrdersClient
      firstPage={ordersPageAction({})}
      companyPromise={getCompanySettingsAction()}
    />
  );
}
