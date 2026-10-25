'use client';

import { AppImage } from '@/components/ui/AppImage';
import { Modal } from '@/components/ui/Modal';
import { addressLine, isOrderPaid, money } from '@/lib/order-admin';
import { lineDisplay, lineFromRow, quantityWords } from '@/lib/unit-rules';
import { shownPaymentReference } from '@/lib/paymentReference';
import type { PublicCompany } from '@/lib/company-view';
import type { Order } from '@/types/index';
import { has } from '@/lib/values';

interface Props {
  order: Order;
  company: PublicCompany;
  busy: boolean;
  onClose: () => void;
  onEmail: () => void;
  onDownload: (type: 'tax_invoice' | 'proforma') => void;
}

/** The tax invoice as it will print, from the company's and the order's own data. */
export function OrderInvoicePreview({ order, company, busy, onClose, onEmail, onDownload }: Props) {
  const companyAddress = [
    company.streetAddress,
    company.city,
    company.countyOrState,
    company.postalCode,
  ]
    .filter((p) => p !== '')
    .join(', ');
  return (
    <Modal title="Tax invoice preview" onClose={onClose}>
      {/* print-sheet pins this subtree to dark-on-white regardless of scheme */}
      <div className="print-sheet w-full space-y-5 rounded-xl bg-white p-4 text-fg-strong sm:p-8">
        <div className="flex flex-wrap items-start justify-between gap-4 border-b border-line-strong pb-4">
          <div className="flex min-w-0 items-start gap-3">
            {!has(company.logoUrl) ? null : (
              <AppImage
                src={company.logoUrl}
                alt={`${company.tradingName} logo`}
                width={48}
                height={48}
                sizes="48px"
                unoptimized
                className="h-12 w-12 rounded-lg border border-line-strong object-contain"
              />
            )}
            <div className="min-w-0">
              <h3 className="text-lg font-black tracking-tight uppercase">{company.tradingName}</h3>
              {company.tagline === '' ? null : (
                <p className="text-[10px] tracking-wider text-fg-subtle uppercase">
                  {company.tagline}
                </p>
              )}
              <p className="text-xs text-fg-faint">{company.legalName}</p>
              <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
                {companyAddress}
                <br />
                {company.country}
                {has(company.locationLabel) ? ` · ${company.locationLabel}` : ''}
                <br />
                {company.email} · {company.phone}
                <br />
                KRA PIN: {company.kraPin}
              </p>
            </div>
          </div>
          <div className="shrink-0 text-right">
            <span className="block text-sm font-black tracking-wide text-fg-strong">
              TAX INVOICE
            </span>
            <span className="mt-1 block font-mono text-sm font-bold">#{order.orderNumber}</span>
            <span className="text-xs text-fg-subtle">
              {new Date(order.createdAt).toLocaleDateString('en-KE')}
            </span>
            <span className="mt-1 block text-[11px] text-fg-subtle capitalize">
              {order.paymentStatus.replace(/_/g, ' ')}
            </span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-4 text-xs sm:grid-cols-2">
          <div>
            <strong className="block text-[10px] text-fg-subtle uppercase">Bill / Ship To</strong>
            <p className="text-sm font-bold">{order.customerName}</p>
            <p>{order.customerPhone}</p>
            {has(order.customerEmail) ? <p>{order.customerEmail}</p> : null}
            <p>{addressLine(order.shippingAddress)}</p>
          </div>
          <div>
            <strong className="block text-[10px] text-fg-subtle uppercase">Payment</strong>
            <p>
              Method:{' '}
              <strong className="uppercase">{order.paymentMethod.replace(/_/g, ' ')}</strong>
            </p>
            <p>
              Reference:{' '}
              <strong className="font-mono">{shownPaymentReference(order) ?? '—'}</strong>
            </p>
            <p>
              Courier: <strong>{order.shippingCourier ?? 'Not assigned'}</strong>
            </p>
            <p>
              Tracking: <strong className="font-mono">{order.trackingNumber ?? 'PENDING'}</strong>
            </p>
          </div>
        </div>

        <div className="space-y-2 sm:hidden" role="list" aria-label="Items">
          {order.items.map((item) => (
            <div
              key={`${item.productId}:${item.unitId ?? ''}:${String(item.quantity)}`}
              role="listitem"
              className="rounded border border-line-strong p-2 text-xs"
            >
              <div className="font-semibold">{item.productName}</div>
              <div className="font-mono">
                {quantityWords(lineFromRow(item))} ×{' '}
                {money(lineDisplay(lineFromRow(item)).unitPrice, order.currency)} ={' '}
                <strong>{money(item.totalPrice, order.currency)}</strong>
              </div>
            </div>
          ))}
        </div>
        <table className="hidden w-full border border-line-strong text-left text-xs sm:table">
          <thead className="border-b border-line-strong bg-surface-sunken font-bold">
            <tr>
              <th className="p-2">Item Description</th>
              <th className="p-2 text-center">Qty</th>
              <th className="p-2 text-right">Unit Price</th>
              <th className="p-2 text-right">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line-strong">
            {order.items.map((item) => (
              <tr key={`${item.productId}:${item.unitId ?? ''}:${String(item.quantity)}`}>
                <td className="p-2">
                  <div className="font-semibold">{item.productName}</div>
                </td>
                <td className="p-2 text-center font-mono font-bold">
                  {quantityWords(lineFromRow(item))}
                </td>
                <td className="p-2 text-right font-mono">
                  {money(lineDisplay(lineFromRow(item)).unitPrice, order.currency)}
                </td>
                <td className="p-2 text-right font-mono font-bold">
                  {money(item.totalPrice, order.currency)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        <div className="ml-auto w-full max-w-[220px] space-y-1 text-xs">
          <div className="flex justify-between text-fg-faint">
            <span>Subtotal</span>
            <span className="font-mono">{money(order.subtotal, order.currency)}</span>
          </div>
          <div className="flex justify-between text-fg-faint">
            <span>VAT</span>
            <span className="font-mono">{money(order.tax, order.currency)}</span>
          </div>
          <div className="flex justify-between text-fg-faint">
            <span>Shipping</span>
            <span className="font-mono">{money(order.shippingFee, order.currency)}</span>
          </div>
          <div className="flex justify-between border-t border-line-strong pt-2 text-sm font-black">
            <span>Total</span>
            <span className="font-mono">{money(order.totalAmount, order.currency)}</span>
          </div>
        </div>

        {company.invoiceFooterNote === '' ? null : (
          <p className="border-t border-line-strong pt-3 text-[11px] text-fg-subtle">
            {company.invoiceFooterNote}
          </p>
        )}

        <div className="flex flex-wrap justify-end gap-3 border-t border-line-strong pt-4">
          <button
            type="button"
            onClick={onClose}
            className="min-h-10 cursor-pointer rounded-lg bg-surface-sunken px-4 py-2 text-xs font-bold text-fg-strong"
          >
            Close
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onEmail}
            className="min-h-10 cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
          >
            Email Tax Invoice
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => onDownload('tax_invoice')}
            className="min-h-10 cursor-pointer rounded-lg bg-surface-raised px-4 py-2 text-xs font-bold text-fg-strong disabled:opacity-50"
          >
            Download Tax Invoice
          </button>
          {isOrderPaid(order) ? null : (
            <button
              type="button"
              disabled={busy}
              onClick={() => onDownload('proforma')}
              className="min-h-10 cursor-pointer rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
            >
              Download Proforma
            </button>
          )}
        </div>
      </div>
    </Modal>
  );
}
