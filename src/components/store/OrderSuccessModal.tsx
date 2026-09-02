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
import {
  generateInvoicePdfAction,
  emailInvoiceAction,
} from '@/server/domains/invoices/actions';
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
    <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/85 p-4 backdrop-blur-md sm:p-6">
      <div className="relative my-8 flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        <div className="relative border-b border-zinc-800 bg-zinc-950 p-6 text-center sm:p-8">
          <div className="mx-auto mb-3 flex h-16 w-16 items-center justify-center rounded-full border border-emerald-500/20 bg-emerald-500/10 text-emerald-400 shadow-lg">
            <CheckCircle2 className="h-9 w-9" />
          </div>
          <h2 className="text-xl font-bold tracking-tight text-white sm:text-2xl">
            Order Successfully Placed & Confirmed!
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            Order <span className="font-mono text-white">{order.orderNumber}</span> is confirmed.
          </p>
        </div>

        <div className="space-y-5 p-6">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <div className="mb-1 flex items-center gap-2 text-[11px] tracking-wider text-zinc-500 uppercase">
                <Package className="h-3.5 w-3.5" /> Fulfillment
              </div>
              <p className="text-sm text-zinc-200">Status: {order.status}</p>
            </div>
            <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
              <div className="mb-1 flex items-center gap-2 text-[11px] tracking-wider text-zinc-500 uppercase">
                <Smartphone className="h-3.5 w-3.5" /> Payment
              </div>
              <p className="text-sm text-zinc-200">{order.paymentMethod}</p>
            </div>
          </div>

          <div className="rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div className="mb-1 flex items-center gap-2 text-[11px] tracking-wider text-zinc-500 uppercase">
              <MapPin className="h-3.5 w-3.5" /> Deliver to
            </div>
            <p className="text-sm text-zinc-200">
              {order.shippingAddress.street}, {order.shippingAddress.city},{' '}
              {order.shippingAddress.countyOrState}
            </p>
          </div>

          <div className="flex items-center justify-between rounded-xl border border-zinc-800 bg-zinc-950 p-4">
            <div>
              <span className="block text-xs text-zinc-400">Total Paid</span>
              <span className="font-mono text-xl font-bold text-white">
                {order.currency} {order.totalAmount.toLocaleString()}
              </span>
            </div>
            <div className="text-right">
              <span className="flex items-center justify-end gap-1 font-mono text-[11px] text-emerald-400">
                <ShieldCheck className="h-3.5 w-3.5" /> Posted tax invoice available
              </span>
            </div>
          </div>

          {notice ? (
            <div className="rounded-lg border border-emerald-800 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200">
              {notice}
            </div>
          ) : null}
          {error ? (
            <div className="rounded-lg border border-red-800 bg-red-950/50 px-3 py-2 text-sm text-red-200">
              {error}
            </div>
          ) : null}

          <div className="grid grid-cols-1 gap-3 pt-2 sm:grid-cols-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runTaxInvoice('download')}
              className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-zinc-700 bg-zinc-800 px-4 py-3 text-xs font-semibold text-zinc-200 transition-colors hover:bg-zinc-700 disabled:opacity-50"
            >
              <Printer className="h-4 w-4" />
              {busy ? 'Working…' : 'Download Tax Invoice'}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runTaxInvoice('email')}
              className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-indigo-700/50 bg-indigo-600/20 px-4 py-3 text-xs font-semibold text-indigo-200 transition-colors hover:bg-indigo-600/30 disabled:opacity-50"
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
