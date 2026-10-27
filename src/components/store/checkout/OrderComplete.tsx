'use client';

import { useState } from 'react';
import Link from 'next/link';
import { ArrowRight, CheckCircle2, Mail, MapPin, Package, Printer, Smartphone } from 'lucide-react';
import type { Order } from '@/types/index';
import { emailInvoiceAction, generateInvoicePdfAction } from '@/server/domains/invoices/actions';
import { downloadPdfBase64 } from '@/lib/downloadPdf';
import { useStore } from '@/components/store/StoreContext';
import { maskedPhone } from '@/lib/phone';
import { OrderProgress } from '@/components/store/OrderProgress';
import { has } from '@/lib/values';

/** The order as the shop has it (read again from the server after payment), with the invoice to keep. */
export function OrderComplete({ order, receipt, onAccount }: { order: Order; receipt: string | null; onAccount: boolean }) {
  const { money, sessionName } = useStore();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const invoice = async (mode: 'download' | 'email') => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = mode === 'email' ? await emailInvoiceAction(order.id, 'tax_invoice') : await generateInvoicePdfAction(order.id, 'tax_invoice');
      downloadPdfBase64(result.pdfBase64, result.filename);
      setNotice(mode === 'email' ? `Tax invoice ${result.invoiceNumber} was emailed to ${order.customerEmail}.` : `Tax invoice ${result.invoiceNumber} was downloaded.`);
    } catch {
      setError('The invoice could not be prepared just now. You can get it later from your order.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-label="Order confirmation" className="mx-auto max-w-2xl space-y-5 pb-8">
      <div className="space-y-2 rounded-2xl border border-line bg-surface p-6 text-center">
        <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-600">
          <CheckCircle2 className="h-8 w-8" aria-hidden="true" />
        </div>
        <h1 className="text-2xl font-bold tracking-tight text-fg-strong">{onAccount ? 'Your order is placed' : 'Thank you, your order is confirmed'}</h1>
        <p className="text-sm text-fg-muted">
          Order <span className="font-mono font-semibold text-fg-strong">{order.orderNumber}</span>
          {has(receipt) ? <> · payment reference <span className="font-mono text-fg-strong">{receipt}</span></> : null}
        </p>
      </div>

      <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <div className="rounded-xl border border-line bg-surface p-4">
          <dt className="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wider text-fg-muted uppercase"><Package className="h-3.5 w-3.5" aria-hidden="true" />Status</dt>
          <dd className="text-sm text-fg-strong capitalize">{order.status.replace(/_/g, ' ')}</dd>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4">
          <dt className="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wider text-fg-muted uppercase"><Smartphone className="h-3.5 w-3.5" aria-hidden="true" />Payment</dt>
          <dd className="text-sm text-fg-strong capitalize">{order.paymentMethod.replace(/_/g, ' ')}</dd>
          {maskedPhone(order.paymentPhone) === '' ? null : <dd className="text-xs text-fg-muted">Paid from <span className="font-mono">{maskedPhone(order.paymentPhone)}</span></dd>}
        </div>
        <div className="rounded-xl border border-line bg-surface p-4 sm:col-span-2">
          <dt className="mb-1 flex items-center gap-2 text-xs font-semibold tracking-wider text-fg-muted uppercase"><MapPin className="h-3.5 w-3.5" aria-hidden="true" />Delivering to</dt>
          <dd className="text-sm text-fg-strong">{order.shippingAddress.street}, {order.shippingAddress.city}, {order.shippingAddress.countyOrState}</dd>
        </div>
        <div className="rounded-xl border border-line bg-surface p-4 sm:col-span-2">
          <dt className="text-xs font-semibold tracking-wider text-fg-muted uppercase">{onAccount ? 'Total on your account' : 'Total'}</dt>
          <dd className="font-mono text-2xl font-bold text-fg-strong">{money(order.totalAmount)}</dd>
        </div>
      </dl>

      <section aria-label="Progress" className="space-y-2 rounded-xl border border-line bg-surface p-4">
        <h2 className="text-xs font-semibold tracking-wider text-fg-muted uppercase">Progress</h2>
        <OrderProgress orderNumber={order.orderNumber} contact={order.customerEmail.trim() === '' ? order.customerPhone : order.customerEmail} />
      </section>

      <p role="status" className="text-sm text-fg-muted">Keep the order number: you can follow this order any time from “Track my order”{sessionName === null ? '' : ' or My orders'}.</p>
      {notice === null ? null : <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200">{notice}</p>}
      {error === null ? null : <p role="alert" className="rounded-lg border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">{error}</p>}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <button type="button" disabled={busy} onClick={() => void invoice('download')} className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface-sunken px-4 py-3 text-sm font-semibold text-fg-strong hover:bg-hover disabled:opacity-50">
          <Printer className="h-4 w-4" aria-hidden="true" />{busy ? 'Working…' : 'Download tax invoice'}
        </button>
        {order.customerEmail.trim() === '' ? null : (
          <button type="button" disabled={busy} onClick={() => void invoice('email')} className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-indigo-600 bg-indigo-50 px-4 py-3 text-sm font-semibold text-indigo-700 hover:bg-indigo-100 disabled:opacity-50 dark:bg-indigo-950/40 dark:text-indigo-300">
            <Mail className="h-4 w-4" aria-hidden="true" />Email tax invoice
          </button>
        )}
      </div>
      <Link href="/" className="flex min-h-12 items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500">
        Continue shopping <ArrowRight className="h-4 w-4" aria-hidden="true" />
      </Link>
    </section>
  );
}
