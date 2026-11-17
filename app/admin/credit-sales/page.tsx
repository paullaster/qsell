import type { Metadata } from 'next';
import { SalesOrdersClient } from '@/components/admin/sales-orders/SalesOrdersClient';
import { creditSalesPageAction } from '@/server/domains/selling/credit-sale-actions';

export const metadata: Metadata = { title: 'Credit sales' };

export default function CreditSalesPage() {
  // The first page loads while the screen is drawn; the list reads it with use() inside Suspense.
  const first = creditSalesPageAction({});
  return <SalesOrdersClient firstPromise={first} variant="credit_sale" />;
}
