import type { Metadata } from 'next';
import { CashSalesClient } from '@/components/admin/cash-sales/CashSalesClient';
import { cashSalesScreenAction } from '@/server/domains/selling/cash-sales/cash-sale-actions';

export const metadata: Metadata = { title: 'Cash Sales' };

export default function CashSalesPage() {
  // The counter loads while it is drawn; the client reads it with use() inside Suspense.
  const first = cashSalesScreenAction();
  return <CashSalesClient firstPromise={first} />;
}
