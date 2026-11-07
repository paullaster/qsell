import { listCurrenciesAdminAction } from '@/server/domains/currencies/actions';
import { AdminCurrenciesClient } from '@/components/admin/AdminCurrenciesClient';

export default function Page() {
  // The currencies, and how the shop's base compares with the books', start together: nothing waits for the other.
  const data = listCurrenciesAdminAction();
  return <AdminCurrenciesClient currenciesPromise={data.then((d) => d.currencies)} linkPromise={data.then((d) => d.link)} />;
}
