import type { Metadata } from 'next';
import { SalesInvoicesClient } from '@/components/admin/sales-invoices/SalesInvoicesClient';
import { salesInvoicesPageAction } from '@/server/domains/selling/sales-invoice-actions';

export const metadata: Metadata = { title: 'Sales invoices' };

export default function SalesInvoicesPage() {
  // The first page loads while the screen is drawn; the list reads it with use() inside Suspense.
  const first = salesInvoicesPageAction({});
  return <SalesInvoicesClient firstPromise={first} />;
}
