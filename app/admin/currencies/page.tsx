import { listCurrenciesAction } from '@/server/domains/currencies/actions';
import { AdminCurrenciesClient } from '@/components/admin/AdminCurrenciesClient';

export default async function Page() {
  const currenciesPromise = listCurrenciesAction();
  return <AdminCurrenciesClient currenciesPromise={currenciesPromise} />;
}
