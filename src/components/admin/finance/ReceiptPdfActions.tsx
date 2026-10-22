'use client';

import { PdfActions } from './PdfActions';

/** A draft is not money received and a cancelled one never was, so only posted and reversed receipts have a PDF. */
export const hasReceiptPdf = (status: string): boolean => status === 'posted' || status === 'reversed';

export function ReceiptPdfActions({ receiptId, status, number, compact = false }: { receiptId: string; status: string; number: string; compact?: boolean }) {
  if (!hasReceiptPdf(status)) return null;
  return <PdfActions url={`/api/admin/finance/receipts/${encodeURIComponent(receiptId)}/pdf`} noun="receipt" number={number} compact={compact} />;
}
