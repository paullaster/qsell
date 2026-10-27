'use client';

import { useState } from 'react';
import { DollarSign, FileText, Mail, MapPin, Phone, Printer, Truck, User } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { ChoicePicker } from '@/components/ui/autocomplete/ChoicePicker';
import { InlineConfirm } from '@/components/ui/InlineConfirm';
import { Field, fieldClass, primaryClass } from '@/components/ui/screen-kit';
import { OrderApprovalBanner } from '@/components/admin/approvals/OrderApprovalBanner';
import { OrderCreditNotesPanel } from '@/components/admin/OrderCreditNotesPanel';
import { OrderReferencePanel } from './OrderReferencePanel';
import { OrderTimelinePanel } from './OrderTimelinePanel';
import { OrderTenderPanel } from '@/components/admin/pricing/OrderTenderPanel';
import {
  FULFILMENT_STATUSES,
  addressLine,
  heldForApproval,
  isOrderPaid,
  money,
  statusChoice,
} from '@/lib/order-admin';
import { has, orElse } from '@/lib/values';
import { nationalPhone, sameMobile } from '@/lib/phone';
import { lineDisplay, lineFromRow, quantityWords } from '@/lib/unit-rules';
import { shownPaymentReference } from '@/lib/paymentReference';
import type { Choice } from '@/lib/payment-options';
import type { Order, OrderStatus } from '@/types/index';
import { OrderStatusBadge } from './OrderStatusBadge';

export interface FulfilmentChange {
  status: OrderStatus;
  shippingCourier: string | undefined;
  trackingNumber: string | undefined;
  internalNotes: string | undefined;
}

interface Props {
  order: Order;
  busy: boolean;
  invoiceBusy: boolean;
  error: string | null;
  notice: string | null;
  onClose: () => void;
  onPreview: () => void;
  onInvoice: (action: 'download' | 'email', type: 'tax_invoice' | 'proforma') => void;
  onSave: (change: FulfilmentChange) => void;
  onCancel: (reason: string) => void;
  /** Something in the panels below changed the order's money or approval: the list is read again. */
  onChanged: () => void;
}

const linkButton =
  'flex min-h-10 cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1.5 text-xs font-medium disabled:opacity-50';

/** One order opened for work: who and what it is, the invoice, the lifecycle form, payments and credit notes. */
export function OrderDetailsModal({
  order,
  busy,
  invoiceBusy,
  error,
  notice,
  onClose,
  onPreview,
  onInvoice,
  onSave,
  onCancel,
  onChanged,
}: Props) {
  const [status, setStatus] = useState<Choice | null>(
    statusChoice(FULFILMENT_STATUSES, order.status),
  );
  const [courier, setCourier] = useState(order.shippingCourier ?? '');
  const [tracking, setTracking] = useState(order.trackingNumber ?? '');
  const [notes, setNotes] = useState(order.internalNotes ?? '');
  const [cancelReason, setCancelReason] = useState('Customer requested order cancellation');
  const held = heldForApproval(order);

  const save = (e: React.SyntheticEvent) => {
    e.preventDefault();
    if (status === null) return;
    const shipping = status.id === 'shipped';
    onSave({
      status: status.id as OrderStatus,
      shippingCourier: shipping ? courier : (order.shippingCourier ?? undefined),
      trackingNumber: shipping ? tracking : (order.trackingNumber ?? undefined),
      internalNotes: notes.trim() === '' ? undefined : notes.trim(),
    });
  };

  return (
    <Modal title={`Order Details: ${order.orderNumber}`} onClose={onClose}>
      <div className="space-y-6 text-xs">
        <p className="text-[11px] text-fg-muted">
          Placed on {new Date(order.createdAt).toLocaleString()}
        </p>

        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Invoices">
          <button
            type="button"
            disabled={invoiceBusy}
            onClick={() => onInvoice('download', 'tax_invoice')}
            className={`${linkButton} bg-surface-sunken text-fg hover:bg-hover`}
          >
            <Printer className="h-3.5 w-3.5" aria-hidden />
            {invoiceBusy ? 'Generating…' : 'Tax Invoice PDF'}
          </button>
          {isOrderPaid(order) ? null : (
            <button
              type="button"
              disabled={invoiceBusy}
              onClick={() => onInvoice('download', 'proforma')}
              className={`${linkButton} bg-amber-600/20 text-amber-800 hover:bg-amber-600/30`}
            >
              <Printer className="h-3.5 w-3.5" aria-hidden />
              Proforma PDF
            </button>
          )}
          <button
            type="button"
            disabled={invoiceBusy}
            onClick={() => onInvoice('email', 'tax_invoice')}
            className={`${linkButton} bg-indigo-600/20 text-indigo-800 hover:bg-indigo-600/30`}
          >
            <Mail className="h-3.5 w-3.5" aria-hidden />
            Email Tax Invoice
          </button>
          {isOrderPaid(order) ? null : (
            <button
              type="button"
              disabled={invoiceBusy}
              onClick={() => onInvoice('email', 'proforma')}
              className={`${linkButton} bg-amber-600/10 text-amber-800 hover:bg-amber-600/20`}
            >
              <Mail className="h-3.5 w-3.5" aria-hidden />
              Email Proforma
            </button>
          )}
          <button
            type="button"
            onClick={onPreview}
            className={`${linkButton} bg-surface-sunken text-fg hover:bg-hover`}
          >
            <FileText className="h-3.5 w-3.5" aria-hidden />
            Preview
          </button>
        </div>

        <div aria-live="polite" className="space-y-2">
          {error === null ? null : (
            <p
              role="alert"
              className="rounded-lg border border-red-800 bg-red-50 p-3.5 text-red-800"
            >
              {error}
            </p>
          )}
          {notice === null ? null : (
            <p
              role="status"
              className="rounded-lg border border-emerald-800 bg-emerald-50 p-3.5 text-emerald-800"
            >
              {notice}
            </p>
          )}
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <section
            className="space-y-2 rounded-xl border border-line bg-surface p-4"
            aria-label="Customer and delivery address"
          >
            <h3 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-strong uppercase">
              <User className="h-3.5 w-3.5 text-indigo-400" aria-hidden />
              Customer &amp; Delivery Address
            </h3>
            <div className="space-y-1 text-fg">
              <div className="text-sm font-bold text-fg-strong">{order.customerName}</div>
              <div className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
                <Phone className="h-3 w-3 text-fg-subtle" aria-hidden />
                {order.customerPhone}
              </div>
              <div className="flex items-center gap-2 text-[11px] text-fg-muted">
                <Mail className="h-3 w-3 text-fg-subtle" aria-hidden />
                {orElse(order.customerEmail, 'No email given')}
              </div>
              <div className="flex items-start gap-2 pt-1 text-[11px] text-fg">
                <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" aria-hidden />
                <span>{addressLine(order.shippingAddress)}</span>
              </div>
            </div>
          </section>

          <section
            className="space-y-2 rounded-xl border border-line bg-surface p-4"
            aria-label="Payment and settlement"
          >
            <h3 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-strong uppercase">
              <DollarSign className="h-3.5 w-3.5 text-emerald-600" aria-hidden />
              Payment &amp; Settlement
            </h3>
            <dl className="space-y-1.5 text-fg">
              <div className="flex items-center justify-between">
                <dt className="text-fg-muted">Method:</dt>
                <dd className="font-mono font-bold text-fg-strong uppercase">
                  {order.paymentMethod}
                </dd>
              </div>
              {has(order.paymentPhone) ? (
                <div className="flex items-center justify-between gap-3">
                  <dt className="text-fg-muted">Paid from:</dt>
                  <dd className="text-right font-mono text-fg-strong">
                    {nationalPhone(order.paymentPhone)}
                    {sameMobile(order.paymentPhone, order.customerPhone) ? null : <span className="block text-xs font-normal text-amber-700 dark:text-amber-300">Not the contact number ({order.customerPhone})</span>}
                  </dd>
                </div>
              ) : null}
              <div className="flex items-center justify-between">
                <dt className="text-fg-muted">Reference:</dt>
                <dd className="font-mono text-fg-strong">
                  {shownPaymentReference(order) ?? 'N/A'}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-fg-muted">Current Status:</dt>
                <dd>
                  <OrderStatusBadge status={order.status} />
                </dd>
              </div>
              <div className="flex items-center justify-between border-t border-line pt-2 font-bold text-fg-strong">
                <dt>Total Amount:</dt>
                <dd className="font-mono text-sm text-emerald-700">
                  {money(order.totalAmount, order.currency)}
                </dd>
              </div>
            </dl>
          </section>
        </div>

        <section className="space-y-2" aria-label="Line items">
          <h3 className="text-xs font-bold tracking-wider text-fg-strong uppercase">
            Itemized Line Items ({order.items.length})
          </h3>
          <ul className="space-y-2 sm:hidden">
            {order.items.map((item) => (
              <li
                key={`${item.productId}:${item.unitId ?? ''}:${String(item.quantity)}`}
                className="rounded-xl border border-line bg-surface p-3"
              >
                <div className="font-medium text-fg-strong">{item.productName}</div>
                <div className="font-mono text-[10px] text-fg-muted">{item.sku}</div>
                <div className="mt-1 font-mono">
                  {quantityWords(lineFromRow(item))} ×{' '}
                  {money(lineDisplay(lineFromRow(item)).unitPrice, order.currency)} ={' '}
                  <strong>{money(item.totalPrice, order.currency)}</strong>
                </div>
              </li>
            ))}
          </ul>
          <div className="hidden overflow-hidden rounded-xl border border-line bg-surface sm:block">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-line bg-surface-raised text-fg-muted">
                <tr>
                  <th className="px-4 py-2.5">Item &amp; SKU</th>
                  <th className="px-4 py-2.5 text-right">Unit Price</th>
                  <th className="px-4 py-2.5 text-center">Qty</th>
                  <th className="px-4 py-2.5 text-right">Subtotal</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line text-fg">
                {order.items.map((item) => (
                  <tr key={`${item.productId}:${item.unitId ?? ''}:${String(item.quantity)}`}>
                    <td className="px-4 py-3 font-medium text-fg-strong">
                      {item.productName}
                      <div className="font-mono text-[10px] text-fg-muted">{item.sku}</div>
                    </td>
                    <td className="px-4 py-3 text-right font-mono">
                      {money(lineDisplay(lineFromRow(item)).unitPrice, order.currency)}
                    </td>
                    <td className="px-4 py-3 text-center font-mono font-bold">
                      {quantityWords(lineFromRow(item))}
                    </td>
                    <td className="px-4 py-3 text-right font-mono font-bold text-fg-strong">
                      {money(item.totalPrice, order.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <OrderApprovalBanner
          order={order}
          onChanged={() => {
            onClose();
            onChanged();
          }}
        />

        <form
          onSubmit={save}
          className="space-y-4 rounded-xl border border-line bg-surface p-4"
          aria-label="Update order fulfilment"
        >
          <h3 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-strong uppercase">
            <Truck className="h-3.5 w-3.5 text-indigo-400" aria-hidden />
            Update Order Fulfillment Lifecycle
          </h3>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <ChoicePicker
              label="Update Status"
              source="order-fulfilment-statuses"
              choice={status}
              onChoice={setStatus}
              clearable={false}
              required
            />
            <Field id={`courier-${order.id}`} label="Shipping Courier">
              <input
                id={`courier-${order.id}`}
                value={courier}
                onChange={(e) => setCourier(e.target.value)}
                placeholder="e.g. Wells Fargo, G4S Kenya"
                className={fieldClass}
                maxLength={80}
                autoComplete="off"
              />
            </Field>
            <Field id={`tracking-${order.id}`} label="Courier Tracking Code">
              <input
                id={`tracking-${order.id}`}
                value={tracking}
                onChange={(e) => setTracking(e.target.value)}
                placeholder="WF-984210"
                className={`${fieldClass} font-mono`}
                maxLength={60}
                autoComplete="off"
              />
            </Field>
          </div>
          <Field id={`notes-${order.id}`} label="Internal Fulfillment Staff Notes">
            <input
              id={`notes-${order.id}`}
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g. Verified payment with M-Pesa statements, dispatched via rider #4"
              className={fieldClass}
              maxLength={300}
              autoComplete="off"
            />
          </Field>
          <div className="flex flex-wrap items-end justify-between gap-3 pt-2">
            <div className="flex flex-wrap items-end gap-3">
              <Field id={`cancel-${order.id}`} label="Reason for cancelling">
                <input
                  id={`cancel-${order.id}`}
                  value={cancelReason}
                  onChange={(e) => setCancelReason(e.target.value)}
                  className={fieldClass}
                  maxLength={200}
                  autoComplete="off"
                />
              </Field>
              {order.status === 'cancelled' ? null : (
                <InlineConfirm
                  label={`Cancel order ${order.orderNumber} and return its stock`}
                  action="Cancel Order & Restock"
                  confirm="Yes, cancel and restock"
                  busy={busy}
                  onConfirm={() => onCancel(cancelReason.trim())}
                />
              )}
            </div>
            <button
              type="submit"
              disabled={busy || held || status === null}
              title={held ? 'This order is held until it is approved.' : undefined}
              className={primaryClass}
            >
              {busy ? 'Saving...' : 'Save Fulfillment Changes'}
            </button>
          </div>
        </form>

        {isOrderPaid(order) && shownPaymentReference(order) === null ? (
          <OrderReferencePanel orderId={order.id} onChanged={onChanged} />
        ) : null}
        <OrderTenderPanel orderId={order.id} onChanged={onChanged} />
        <OrderTimelinePanel orderId={order.id} />
        <OrderCreditNotesPanel key={order.id} orderId={order.id} />
      </div>
    </Modal>
  );
}
