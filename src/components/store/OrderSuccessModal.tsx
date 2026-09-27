'use client';

import { useState } from 'react';
import {
  CheckCircle2,
  Package,
  Smartphone,
  ShieldCheck,
  Printer,
  ArrowRight,
  MapPin,
  Mail,
} from 'lucide-react';
import { type Order } from '@/types/index';
import { generateInvoicePdfAction, emailInvoiceAction } from '@/server/domains/invoices/actions';
import { downloadPdfBase64 } from '@/lib/downloadPdf';

interface OrderSuccessModalProps {
  isOpen: boolean;
  onClose: () => void;
  order: Order | null;
  onContinueShopping: () => void;
}

export function OrderSuccessModal({
  isOpen,
  onClose,
  order,
  onContinueShopping,
}: OrderSuccessModalProps) {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen || !order) return null;

  const runTaxInvoice = async (mode: 'download' | 'email') => {
    try {
      setBusy(true);
      setError(null);
      const result =
        mode === 'email'
          ? await emailInvoiceAction(order.id, 'tax_invoice')
          : await generateInvoicePdfAction(order.id, 'tax_invoice');
      downloadPdfBase64(result.pdfBase64, result.filename);
      setNotice(
        mode === 'email'
          ? `Posted tax invoice ${result.invoiceNumber} emailed to ${order.customerEmail}.`
          : `Posted tax invoice ${result.invoiceNumber} downloaded.`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Invoice action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-backdrop/85 p-0 backdrop-blur-md sm:items-center sm:p-4">
      <div className="relative flex min-h-dvh w-full max-w-2xl flex-col overflow-hidden border border-line bg-surface-raised shadow-2xl sm:my-4 sm:min-h-0 sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl lg:max-h-[90vh]">
        <div className="relative border-b border-line bg-surface p-4 text-center sm:p-8">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-600 shadow-lg sm:h-16 sm:w-16">
            <CheckCircle2 className="h-7 w-7 sm:h-9 sm:w-9" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-fg-strong sm:text-2xl">
            Order Successfully Placed & Confirmed!
          </h2>
          <p className="mt-2 text-sm text-fg-muted">
            Order <span className="font-mono text-fg-strong">{order.orderNumber}</span> is
            confirmed.
          </p>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 sm:space-y-5 sm:p-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="mb-1 flex items-center gap-2 text-[11px] tracking-wider text-fg-subtle uppercase">
                <Package className="h-3.5 w-3.5" /> Fulfillment
              </div>
              <p className="text-sm text-fg-strong">Status: {order.status}</p>
            </div>
            <div className="rounded-xl border border-line bg-surface p-4">
              <div className="mb-1 flex items-center gap-2 text-[11px] tracking-wider text-fg-subtle uppercase">
                <Smartphone className="h-3.5 w-3.5" /> Payment
              </div>
              <p className="text-sm text-fg-strong">{order.paymentMethod}</p>
            </div>
          </div>

          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="mb-1 flex items-center gap-2 text-[11px] tracking-wider text-fg-subtle uppercase">
              <MapPin className="h-3.5 w-3.5" /> Deliver to
            </div>
            <p className="text-sm text-fg-strong">
              {order.shippingAddress.street}, {order.shippingAddress.city},{' '}
              {order.shippingAddress.countyOrState}
            </p>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-line bg-surface p-4">
            <div>
              <span className="block text-xs text-fg-muted">Total Paid</span>
              <span className="font-mono text-xl font-bold text-fg-strong">
                {order.currency} {order.totalAmount.toLocaleString()}
              </span>
            </div>
            <div className="text-right">
              <span className="flex items-center justify-end gap-1 font-mono text-[11px] text-emerald-600">
                <ShieldCheck className="h-3.5 w-3.5" /> Posted tax invoice available
              </span>
            </div>
          </div>

          {notice ? (
            <div className="rounded-lg border border-emerald-800 bg-emerald-50/50 px-3 py-2 text-sm text-emerald-800">
              {notice}
            </div>
          ) : null}
          {error ? (
            <div className="rounded-lg border border-red-800 bg-red-50/50 px-3 py-2 text-sm text-red-800">
              {error}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runTaxInvoice('download')}
              className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-line-strong bg-surface-sunken px-4 py-3 text-xs font-semibold text-fg-strong transition-colors hover:bg-hover disabled:opacity-50"
            >
              <Printer className="h-4 w-4" />
              {busy ? 'Working…' : 'Download Tax Invoice'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runTaxInvoice('email')}
              className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-indigo-600 bg-indigo-50 px-4 py-3 text-xs font-semibold text-indigo-600 dark:text-indigo-400 transition-colors hover:bg-indigo-100 dark:hover:bg-indigo-900/30 disabled:opacity-50"
            >
              <Mail className="h-4 w-4" />
              Email Tax Invoice
            </button>
          </div>

          <button
            type="button"
            onClick={() => {
              onClose();
              onContinueShopping();
            }}
            className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-3 text-xs font-bold text-white shadow-lg shadow-indigo-600/20 transition-colors hover:bg-indigo-500"
          >
            Continue Shopping
            <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}
