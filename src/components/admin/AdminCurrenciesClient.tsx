'use client';

import { useRouter } from 'next/navigation';
import { AdminCurrencies } from '@/components/admin/AdminCurrencies';
import type { CurrencyConfig } from '@/types/index';

export function AdminCurrenciesClient({
  currenciesPromise,
}: {
  currenciesPromise: Promise<CurrencyConfig[]>;
}) {
  const router = useRouter();
  return (
    <AdminCurrencies currenciesPromise={currenciesPromise} onRefreshAll={() => router.refresh()} />
  );
}
