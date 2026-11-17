'use client';

import { useEffect, useState } from 'react';
import { FileText } from 'lucide-react';
import { orderDocumentsAction } from '@/server/domains/selling/order-documents-actions';
import type { RelatedDocuments } from '@/server/domains/selling/order-documents-service';

const money = (currency: string, amount: number): string => `${currency} ${amount.toLocaleString()}`;
const INVOICE_WORDS: Record<string, string> = { tax_invoice: 'Tax invoice', proforma: 'Proforma invoice', delivery_invoice: 'Delivery invoice' };

/**
 * The documents before and after this order: the quote it was made from and the invoices raised for it. Deliveries and credit notes
 * have their own panels beside it. Shows nothing when there is neither (an order that came straight from the web shop and is not yet
 * invoiced), and nothing to people who may not see orders.
 */
export function OrderDocumentsPanel({ orderId }: { orderId: string }) {
  const [docs, setDocs] = useState<RelatedDocuments | null>(null);
  useEffect(() => {
    let live = true;
    void orderDocumentsAction(orderId).then((r) => {
      if (live && r.ok) setDocs(r.data);
    });
    return () => {
      live = false;
    };
  }, [orderId]);
  if (docs === null || (docs.quote === null && docs.invoices.length === 0)) return null;
  return (
    <section className="space-y-2 rounded-xl border border-line bg-surface p-4" aria-label="Related documents" data-testid="order-documents">
      <h3 className="flex items-center gap-2 text-sm font-bold text-fg-strong"><FileText className="h-4 w-4" aria-hidden="true" />Related documents</h3>
      <ol className="space-y-1 text-sm">
        {docs.quote === null ? null : <li data-testid="order-document-quote">Quote <span className="font-semibold">{docs.quote.number}</span> ({docs.quote.status.replaceAll('_', ' ')}, {money(docs.quote.currency, docs.quote.total)}): this order was made from it</li>}
        <li className="font-semibold text-fg-strong">Order {docs.orderNumber}</li>
        {docs.invoices.map((i) => (
          <li key={i.number} data-testid="order-document-invoice">{INVOICE_WORDS[i.type] ?? i.type.replaceAll('_', ' ')} <span className="font-semibold">{i.number}</span> ({money(i.currency, i.total)}, {new Date(i.createdAt).toLocaleDateString()}{i.emailed ? ', emailed' : ''})</li>
        ))}
      </ol>
    </section>
  );
}
