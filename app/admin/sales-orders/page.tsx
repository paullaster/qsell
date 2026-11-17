import type { Metadata } from 'next';
import { SalesOrdersClient } from '@/components/admin/sales-orders/SalesOrdersClient';
import { salesOrdersPageAction } from '@/server/domains/selling/sales-order-actions';

export const metadata: Metadata = { title: 'Sales orders' };

export default function SalesOrdersPage() {
  // The first page loads while the screen is drawn; the list reads it with use() inside Suspense.
  const first = salesOrdersPageAction({});
  return <SalesOrdersClient firstPromise={first} />;
}
