'use client';

import { useRouter } from 'next/navigation';
import { AdminCurrencies } from '@/components/admin/AdminCurrencies';
import type { CurrencyConfig } from '@/types/index';
import type { FinanceLink } from '@/server/domains/currencies/service';

export function AdminCurrenciesClient({
  currenciesPromise,
  linkPromise,
}: {
  currenciesPromise: Promise<CurrencyConfig[]>;
  linkPromise: Promise<FinanceLink>;
}) {
  const router = useRouter();
  return (
    <AdminCurrencies currenciesPromise={currenciesPromise} linkPromise={linkPromise} onRefreshAll={() => router.refresh()} />
  );
}
