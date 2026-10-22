'use client';

import { PdfActions } from './PdfActions';

/** The tax invoice of an order that is already in the customer's account. */
export function InvoicePdfActions({ orderId, number, compact = false }: { orderId: string; number: string; compact?: boolean }) {
  return <PdfActions url={`/api/admin/finance/invoices/${encodeURIComponent(orderId)}/pdf`} noun="invoice" number={number} compact={compact} />;
}
