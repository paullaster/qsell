import { exchangeRatesOverviewAction } from '@/server/domains/finance/fx-actions';
import { ExchangeRatesClient } from '@/components/admin/finance/ExchangeRatesClient';
import { FinancePage } from '@/components/admin/finance/gate';

export default function Page() {
  const view = exchangeRatesOverviewAction();
  return (
    <FinancePage label="exchange rates">
      <ExchangeRatesClient viewPromise={view} />
    </FinancePage>
  );
}
