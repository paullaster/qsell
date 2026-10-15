'use client';

import { OrderApprovalBanner } from './approvals/OrderApprovalBanner';
import React, { use, useState } from 'react';
import {
  ShoppingBag,
  Search,
  Filter,
  Eye,
  Truck,
  CheckCircle2,
  XCircle,
  Clock,
  AlertCircle,
  FileText,
  Printer,
  Phone,
  Mail,
  MapPin,
  User,
  DollarSign,
  RefreshCw,
  X,
  ExternalLink,
} from 'lucide-react';
import { type Order, type OrderStatus } from '@/types/index';
import { AppImage } from '@/components/ui/AppImage';
import { updateOrderStatusAction, cancelOrderAction } from '@/server/actions';
import { generateInvoicePdfAction, emailInvoiceAction } from '@/server/domains/invoices/actions';
import { OrderCreditNotesPanel } from '@/components/admin/OrderCreditNotesPanel';
import { OrderTenderPanel } from '@/components/admin/pricing/OrderTenderPanel';
import { downloadPdfBase64 } from '@/lib/downloadPdf';
import type { CompanySettingsRow } from '@/server/db/drizzle/schema';
import { shownPaymentReference } from '@/lib/paymentReference';

interface AdminOrdersProps {
  ordersPromise: Promise<Order[]>;
  companyPromise: Promise<CompanySettingsRow>;
  onRefresh: () => void;
}

function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

const heldForApproval = (order: Order) =>
  ['pending', 'rejected', 'draft'].includes(order.approvalStatus ?? 'none');

export function AdminOrders({ ordersPromise, companyPromise, onRefresh }: AdminOrdersProps) {
  const orders = use(ordersPromise);
  const company = use(companyPromise);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<string>('all');
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null);

  // Fulfillment Form States
  const [newStatus, setNewStatus] = useState<OrderStatus>('processing');
  const [shippingCourier, setShippingCourier] = useState('Wells Fargo Courier Kenya');
  const [trackingNumber, setTrackingNumber] = useState('');
  const [internalNotes, setInternalNotes] = useState('');
  const [cancelReason, setCancelReason] = useState('Customer requested order cancellation');

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [isPrintModalOpen, setIsPrintModalOpen] = useState(false);
  const [invoiceBusy, setInvoiceBusy] = useState(false);
  const [invoiceNotice, setInvoiceNotice] = useState<string | null>(null);

  const isOrderPaid = (order: Order) =>
    order.paymentStatus === 'paid' || order.paymentStatus === 'reconciled';

  const handleDownloadInvoice = async (
    orderId: string,
    documentType: 'tax_invoice' | 'proforma' = 'tax_invoice',
  ) => {
    try {
      setInvoiceBusy(true);
      setInvoiceNotice(null);
      const result = await generateInvoicePdfAction(orderId, documentType);
      downloadPdfBase64(result.pdfBase64, result.filename);
      const kind = documentType === 'proforma' ? 'Proforma invoice' : 'Posted tax invoice';
      setInvoiceNotice(`${kind} ${result.invoiceNumber} downloaded.`);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Invoice generation failed');
    } finally {
      setInvoiceBusy(false);
    }
  };

  const handleEmailInvoice = async (
    orderId: string,
    documentType: 'tax_invoice' | 'proforma' = 'tax_invoice',
  ) => {
    try {
      setInvoiceBusy(true);
      setInvoiceNotice(null);
      const result = await emailInvoiceAction(orderId, documentType);
      downloadPdfBase64(result.pdfBase64, result.filename);
      const kind = documentType === 'proforma' ? 'Proforma invoice' : 'Posted tax invoice';
      setInvoiceNotice(
        `${kind} ${result.invoiceNumber} emailed to customer${result.emailMessageId ? ` (${result.emailMessageId})` : ''}.`,
      );
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Invoice email failed');
    } finally {
      setInvoiceBusy(false);
    }
  };

  // Filter Orders
  const filteredOrders = orders.filter((o) => {
    const matchesSearch =
      o.orderNumber.toLowerCase().includes(search.toLowerCase()) ||
      o.customerName.toLowerCase().includes(search.toLowerCase()) ||
      o.customerPhone.toLowerCase().includes(search.toLowerCase()) ||
      o.customerEmail.toLowerCase().includes(search.toLowerCase()) ||
      o.trackingNumber?.toLowerCase().includes(search.toLowerCase());

    const matchesStatus = statusFilter === 'all' || o.status === statusFilter;
    return matchesSearch && matchesStatus;
  });

  const openOrderDrawer = (order: Order) => {
    setSelectedOrder(order);
    setNewStatus(order.status);
    setShippingCourier(order.shippingCourier || 'Wells Fargo Courier Kenya');
    setTrackingNumber(order.trackingNumber || `WF-${Math.floor(100000 + Math.random() * 900000)}`);
    setInternalNotes(order.internalNotes || '');
    setActionError(null);
  };

  const handleUpdateStatus = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedOrder) return;
    try {
      setIsSubmitting(true);
      setActionError(null);
      const updated = await updateOrderStatusAction(selectedOrder.id, {
        status: newStatus,
        shippingCourier: newStatus === 'shipped' ? shippingCourier : selectedOrder.shippingCourier,
        trackingNumber: newStatus === 'shipped' ? trackingNumber : selectedOrder.trackingNumber,
        internalNotes: internalNotes.trim() || undefined,
      });
      setSelectedOrder(updated);
      onRefresh();
    } catch (err: any) {
      setActionError(err.message);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleCancelOrder = async () => {
    if (!selectedOrder) return;
    if (
      window.confirm(
        `Are you sure you want to cancel order ${selectedOrder.orderNumber}? This will automatically return all reserved inventory items back to active stock.`,
      )
    ) {
      try {
        setIsSubmitting(true);
        setActionError(null);
        const updated = await cancelOrderAction(selectedOrder.id, cancelReason);
        setSelectedOrder(updated);
        onRefresh();
      } catch (err: any) {
        setActionError(err.message);
      } finally {
        setIsSubmitting(false);
      }
    }
  };

  const getStatusBadge = (status: OrderStatus) => {
    switch (status) {
      case 'delivered':
      case 'completed':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-emerald-800 bg-emerald-50/80 px-2.5 py-0.5 text-[11px] font-semibold text-emerald-700">
            <CheckCircle2 className="h-3 w-3" /> Delivered
          </span>
        );
      case 'shipped':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-blue-800 bg-blue-50 px-2.5 py-0.5 text-[11px] font-semibold text-blue-700">
            <Truck className="h-3 w-3" /> In Transit
          </span>
        );
      case 'processing':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-indigo-800 bg-indigo-50 px-2.5 py-0.5 text-[11px] font-semibold text-indigo-300">
            <Clock className="h-3 w-3" /> Processing
          </span>
        );
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-amber-800 bg-amber-50 px-2.5 py-0.5 text-[11px] font-semibold text-amber-700">
            <AlertCircle className="h-3 w-3" /> Pending Payment
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-red-800 bg-red-50 px-2.5 py-0.5 text-[11px] font-semibold text-red-700">
            <XCircle className="h-3 w-3" /> Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 rounded-full border border-line-strong bg-surface-sunken px-2.5 py-0.5 text-[11px] font-semibold text-fg">
            {status}
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col justify-between gap-4 rounded-xl border border-line bg-surface-raised p-5 sm:flex-row sm:items-center">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold text-fg-strong">
            <ShoppingBag className="h-5 w-5 text-indigo-400" />
            Customer Orders & Shipment Processing
          </h2>
          <p className="mt-0.5 text-xs text-fg-muted">
            Review incoming customer orders, assign courier delivery tracking, print packing slips,
            and manage cancellations with automatic stock return.
          </p>
        </div>

        <button
          onClick={onRefresh}
          className="flex w-fit cursor-pointer items-center gap-1 rounded-lg bg-surface-sunken px-3 py-1.5 text-xs font-semibold text-fg transition-colors hover:bg-hover hover:text-fg-strong"
        >
          <RefreshCw className="h-3.5 w-3.5" />
          Refresh Orders
        </button>
      </div>

      {/* Filter and Search */}
      <div className="flex flex-col items-center justify-between gap-3 rounded-xl border border-line bg-surface-raised p-4 text-xs sm:flex-row">
        <div className="relative w-full sm:w-80">
          <Search className="absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
          <input
            type="text"
            placeholder="Search Order #, customer name, phone, tracking..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full rounded-lg border border-line bg-surface py-1.5 pr-4 pl-9 text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
          />
        </div>

        <div className="flex w-full items-center gap-2 sm:w-auto">
          <span className="text-fg-subtle">Status:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="cursor-pointer rounded-lg border border-line bg-surface px-3 py-1.5 text-xs text-fg-strong focus:border-indigo-500 focus:outline-none"
          >
            <option value="all">All Statuses ({orders.length})</option>
            <option value="pending">Pending Payment</option>
            <option value="processing">Processing / Paid</option>
            <option value="shipped">In Transit / Shipped</option>
            <option value="delivered">Delivered</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
      </div>

      {/* Orders Table */}
      <div className="overflow-hidden rounded-xl border border-line bg-surface-raised shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="border-b border-line bg-surface font-semibold text-fg-muted">
              <tr>
                <th className="px-4 py-3">Order #</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Customer</th>
                <th className="px-4 py-3 text-center">Items</th>
                <th className="px-4 py-3 text-right">Total Amount</th>
                <th className="px-4 py-3 text-center">Payment Info</th>
                <th className="px-4 py-3 text-center">Status</th>
                <th className="px-4 py-3 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line text-fg">
              {filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-fg-subtle">
                    No orders match the current filter criteria.
                  </td>
                </tr>
              ) : (
                filteredOrders.map((o) => (
                  <tr key={o.id} className="transition-colors hover:bg-hover">
                    <td className="px-4 py-3.5 font-mono font-bold text-fg-strong">
                      {o.orderNumber}
                    </td>
                    <td className="px-4 py-3.5 text-[11px] text-fg-muted">
                      {new Date(o.createdAt).toLocaleDateString()}{' '}
                      {new Date(o.createdAt).toLocaleTimeString([], {
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </td>
                    <td className="px-4 py-3.5">
                      <div className="font-semibold text-fg-strong">{o.customerName}</div>
                      <div className="font-mono text-[11px] text-fg-muted">{o.customerPhone}</div>
                    </td>
                    <td className="px-4 py-3.5 text-center font-mono font-bold text-fg">
                      {o.items.reduce((acc, i) => acc + i.quantity, 0)}
                    </td>
                    <td className="px-4 py-3.5 text-right font-mono font-bold text-fg-strong">
                      {money(o.totalAmount, o.currency)}
                    </td>
                    <td className="px-4 py-3.5 text-center">
                      <div className="inline-flex flex-col items-center">
                        <span className="rounded bg-surface-sunken px-2 py-0.5 font-mono text-[10px] font-bold text-fg uppercase">
                          {o.paymentMethod}
                        </span>
                        {(() => {
                          const reference = shownPaymentReference(o);
                          return reference ? (
                            <span
                              className="mt-0.5 max-w-[100px] truncate font-mono text-[9px] text-fg-subtle"
                              title={reference}
                            >
                              Ref: {reference}
                            </span>
                          ) : null;
                        })()}
                      </div>
                    </td>
                    <td className="px-4 py-3.5 text-center">{getStatusBadge(o.status)}</td>
                    <td className="px-4 py-3.5 text-right">
                      <button
                        onClick={() => openOrderDrawer(o)}
                        className="cursor-pointer rounded-lg border border-line-strong bg-surface-sunken px-3 py-1.5 text-xs font-medium text-fg-strong transition-colors hover:bg-hover hover:text-fg-strong"
                      >
                        Manage & Fulfill
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Order Fulfillment Details Modal */}
      {selectedOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-backdrop/80 p-4 backdrop-blur-md sm:p-6">
          <div className="relative my-8 flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-2xl border border-line bg-surface-raised text-xs shadow-2xl">
            {/* Modal Header */}
            <div className="flex items-center justify-between border-b border-line bg-surface p-5">
              <div className="flex items-center gap-3">
                <div className="flex h-9 w-9 items-center justify-center rounded-xl border border-indigo-500/30 bg-indigo-600/20 text-indigo-400">
                  <ShoppingBag className="h-5 w-5" />
                </div>
                <div>
                  <h3 className="text-base font-bold text-fg-strong">
                    Order Details: {selectedOrder.orderNumber}
                  </h3>
                  <p className="text-[11px] text-fg-muted">
                    Placed on {new Date(selectedOrder.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="flex flex-wrap items-center justify-end gap-2">
                <button
                  type="button"
                  disabled={invoiceBusy}
                  onClick={() => {
                    if (selectedOrder) void handleDownloadInvoice(selectedOrder.id, 'tax_invoice');
                  }}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-surface-sunken px-3 py-1.5 text-fg hover:bg-hover hover:text-fg-strong disabled:opacity-50"
                >
                  <Printer className="h-3.5 w-3.5" />
                  {invoiceBusy ? 'Generating…' : 'Tax Invoice PDF'}
                </button>
                {!isOrderPaid(selectedOrder) ? (
                  <button
                    type="button"
                    disabled={invoiceBusy}
                    onClick={() => {
                      if (selectedOrder) void handleDownloadInvoice(selectedOrder.id, 'proforma');
                    }}
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-amber-600/20 px-3 py-1.5 text-amber-800 hover:bg-amber-600/30 disabled:opacity-50"
                  >
                    <Printer className="h-3.5 w-3.5" />
                    Proforma PDF
                  </button>
                ) : null}
                <button
                  type="button"
                  disabled={invoiceBusy}
                  onClick={() => {
                    if (selectedOrder) void handleEmailInvoice(selectedOrder.id, 'tax_invoice');
                  }}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600/20 px-3 py-1.5 text-indigo-300 hover:bg-indigo-600/30 disabled:opacity-50"
                >
                  <Mail className="h-3.5 w-3.5" />
                  Email Tax Invoice
                </button>
                {!isOrderPaid(selectedOrder) ? (
                  <button
                    type="button"
                    disabled={invoiceBusy}
                    onClick={() => {
                      if (selectedOrder) void handleEmailInvoice(selectedOrder.id, 'proforma');
                    }}
                    className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-amber-600/10 px-3 py-1.5 text-amber-800 hover:bg-amber-600/20 disabled:opacity-50"
                  >
                    <Mail className="h-3.5 w-3.5" />
                    Email Proforma
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => setIsPrintModalOpen(true)}
                  className="flex cursor-pointer items-center gap-1.5 rounded-lg bg-surface-sunken px-3 py-1.5 text-fg hover:bg-hover hover:text-fg-strong"
                >
                  <FileText className="h-3.5 w-3.5" />
                  Preview
                </button>
                <button
                  onClick={() => setSelectedOrder(null)}
                  className="cursor-pointer rounded-lg p-1 text-fg-muted hover:text-fg-strong"
                >
                  <X className="h-5 w-5" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="flex-1 space-y-6 overflow-y-auto p-6">
              {actionError && (
                <div className="rounded-lg border border-red-800 bg-red-50 p-3.5 text-red-800">
                  {actionError}
                </div>
              )}
              {invoiceNotice && (
                <div className="rounded-lg border border-emerald-800 bg-emerald-50 p-3.5 text-emerald-800">
                  {invoiceNotice}
                </div>
              )}

              {/* Status and Customer Overview */}
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                {/* Customer Details */}
                <div className="space-y-2 rounded-xl border border-line bg-surface p-4">
                  <h4 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-muted text-fg-strong uppercase">
                    <User className="h-3.5 w-3.5 text-indigo-400" />
                    Customer & Delivery Address
                  </h4>
                  <div className="space-y-1 text-fg">
                    <div className="text-sm font-bold text-fg-strong">
                      {selectedOrder.customerName}
                    </div>
                    <div className="flex items-center gap-2 font-mono text-[11px] text-fg-muted">
                      <Phone className="h-3 w-3 text-fg-subtle" />
                      {selectedOrder.customerPhone}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-fg-muted">
                      <Mail className="h-3 w-3 text-fg-subtle" />
                      {selectedOrder.customerEmail}
                    </div>
                    <div className="flex items-start gap-2 pt-1 text-[11px] text-fg">
                      <MapPin className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg-subtle" />
                      <span>
                        {selectedOrder.shippingAddress
                          ? `${selectedOrder.shippingAddress.street}, ${selectedOrder.shippingAddress.city}, ${selectedOrder.shippingAddress.countyOrState}, ${selectedOrder.shippingAddress.country}`
                          : 'No shipping address on file'}
                      </span>
                    </div>
                  </div>
                </div>

                {/* Payment Overview */}
                <div className="space-y-2 rounded-xl border border-line bg-surface p-4">
                  <h4 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-muted text-fg-strong uppercase">
                    <DollarSign className="h-3.5 w-3.5 text-emerald-600" />
                    Payment & Settlement
                  </h4>
                  <div className="space-y-1.5 text-fg">
                    <div className="flex items-center justify-between">
                      <span className="text-fg-muted">Method:</span>
                      <span className="font-mono font-bold text-fg-strong uppercase">
                        {selectedOrder.paymentMethod}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-fg-muted">Reference:</span>
                      <span className="font-mono text-fg-strong">
                        {shownPaymentReference(selectedOrder) || 'N/A'}
                      </span>
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-fg-muted">Current Status:</span>
                      {getStatusBadge(selectedOrder.status)}
                    </div>
                    <div className="flex items-center justify-between border-t border-line pt-2 font-bold text-fg-strong">
                      <span>Total Amount:</span>
                      <span className="font-mono text-sm text-emerald-600">
                        {money(selectedOrder.totalAmount, selectedOrder.currency)}
                      </span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Itemized Order Line Items */}
              <div className="space-y-2">
                <h4 className="text-xs font-bold tracking-wider text-fg-muted text-fg-strong uppercase">
                  Itemized Line Items ({selectedOrder.items.length})
                </h4>
                <div className="overflow-hidden rounded-xl border border-line bg-surface">
                  <table className="w-full text-left text-xs">
                    <thead className="border-b border-line bg-surface-raised text-fg-muted">
                      <tr>
                        <th className="px-4 py-2.5">Item & SKU</th>
                        <th className="px-4 py-2.5 text-right">Unit Price</th>
                        <th className="px-4 py-2.5 text-center">Qty</th>
                        <th className="px-4 py-2.5 text-right">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line text-fg">
                      {selectedOrder.items.map((item, idx) => (
                        <tr key={idx}>
                          <td className="px-4 py-3 font-medium text-fg-strong">
                            {item.productName}
                            <div className="font-mono text-[10px] text-fg-muted">{item.sku}</div>
                          </td>
                          <td className="px-4 py-3 text-right font-mono">
                            {money(item.unitPrice, selectedOrder.currency)}
                          </td>
                          <td className="px-4 py-3 text-center font-mono font-bold">
                            {item.quantity}
                          </td>
                          <td className="px-4 py-3 text-right font-mono font-bold text-fg-strong">
                            {money(item.unitPrice * item.quantity, selectedOrder.currency)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <OrderApprovalBanner
                order={selectedOrder}
                onChanged={() => {
                  setSelectedOrder(null);
                  onRefresh();
                }}
              />

              {/* Fulfillment Status Management Form */}
              <form
                onSubmit={handleUpdateStatus}
                className="space-y-4 rounded-xl border border-line bg-surface p-4"
              >
                <h4 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-fg-muted text-fg-strong uppercase">
                  <Truck className="h-3.5 w-3.5 text-indigo-400" />
                  Update Order Fulfillment Lifecycle
                </h4>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
                  <div>
                    <label className="mb-1 block font-semibold text-fg">Update Status</label>
                    <select
                      value={newStatus}
                      onChange={(e) => setNewStatus(e.target.value as OrderStatus)}
                      className="w-full cursor-pointer rounded-lg border border-line bg-surface-raised px-3 py-2 text-fg-strong focus:border-indigo-500"
                    >
                      <option value="pending">Pending Payment</option>
                      <option value="processing">Processing / Order Confirmed</option>
                      <option value="shipped">Dispatched / In Transit</option>
                      <option value="delivered">Delivered to Customer</option>
                      <option value="cancelled">Cancelled (Restock)</option>
                    </select>
                  </div>

                  <div>
                    <label className="mb-1 block font-semibold text-fg">Shipping Courier</label>
                    <input
                      type="text"
                      value={shippingCourier}
                      onChange={(e) => setShippingCourier(e.target.value)}
                      placeholder="e.g. Wells Fargo, G4S Kenya"
                      className="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-fg-strong focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="mb-1 block font-semibold text-fg">
                      Courier Tracking Code
                    </label>
                    <input
                      type="text"
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                      placeholder="WF-984210"
                      className="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 font-mono text-fg-strong focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="mb-1 block font-semibold text-fg">
                    Internal Fulfillment Staff Notes
                  </label>
                  <input
                    type="text"
                    value={internalNotes}
                    onChange={(e) => setInternalNotes(e.target.value)}
                    placeholder="e.g. Verified payment with M-Pesa statements, dispatched via rider #4"
                    className="w-full rounded-lg border border-line bg-surface-raised px-3 py-2 text-fg-strong focus:border-indigo-500"
                  />
                </div>

                <div className="flex items-center justify-between pt-2">
                  <button
                    type="button"
                    onClick={handleCancelOrder}
                    disabled={selectedOrder.status === 'cancelled' || isSubmitting}
                    className="cursor-pointer rounded-lg border border-red-800 bg-red-50 px-3 py-1.5 font-semibold text-red-700 hover:bg-red-100 disabled:opacity-40"
                  >
                    Cancel Order & Restock
                  </button>

                  <button
                    type="submit"
                    disabled={isSubmitting || heldForApproval(selectedOrder)}
                    title={
                      heldForApproval(selectedOrder)
                        ? 'This order is held until it is approved.'
                        : undefined
                    }
                    className="cursor-pointer rounded-lg bg-indigo-600 px-5 py-2 font-bold text-white shadow-lg shadow-indigo-600/20 hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {isSubmitting ? 'Saving...' : 'Save Fulfillment Changes'}
                  </button>
                </div>
              </form>

              <OrderTenderPanel orderId={selectedOrder.id} onChanged={onRefresh} />

              <OrderCreditNotesPanel key={selectedOrder.id} orderId={selectedOrder.id} />
            </div>
          </div>
        </div>
      )}

      {/* Tax invoice preview — company + order from live data */}
      {isPrintModalOpen && selectedOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-backdrop/90 p-4">
          {/* print-sheet pins this subtree to dark-on-white regardless of scheme */}
          <div className="print-sheet w-full max-w-2xl space-y-5 rounded-xl bg-white p-8 text-fg-strong shadow-2xl">
            <div className="flex items-start justify-between gap-4 border-b border-line-strong pb-4">
              <div className="flex min-w-0 items-start gap-3">
                {company.logoUrl ? (
                  <AppImage
                    src={company.logoUrl}
                    alt={`${company.tradingName} logo`}
                    width={48}
                    height={48}
                    sizes="48px"
                    unoptimized
                    className="h-12 w-12 rounded-lg border border-line-strong object-contain"
                  />
                ) : null}
                <div className="min-w-0">
                  <h1 className="text-lg font-black tracking-tight uppercase">
                    {company.tradingName}
                  </h1>
                  {company.tagline ? (
                    <p className="text-[10px] tracking-wider text-fg-subtle uppercase">
                      {company.tagline}
                    </p>
                  ) : null}
                  <p className="text-xs text-fg-faint">{company.legalName}</p>
                  <p className="mt-1 text-[11px] leading-relaxed text-fg-subtle">
                    {[
                      company.streetAddress,
                      company.city,
                      company.countyOrState,
                      company.postalCode,
                    ]
                      .filter(Boolean)
                      .join(', ')}
                    <br />
                    {company.country}
                    {company.locationLabel ? ` · ${company.locationLabel}` : ''}
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
                <span className="mt-1 block font-mono text-sm font-bold">
                  #{selectedOrder.orderNumber}
                </span>
                <span className="text-xs text-fg-subtle">
                  {new Date(selectedOrder.createdAt).toLocaleDateString('en-KE')}
                </span>
                <span className="mt-1 block text-[11px] text-fg-subtle capitalize">
                  {selectedOrder.paymentStatus.replace(/_/g, ' ')}
                </span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <strong className="block text-[10px] text-fg-subtle uppercase">
                  Bill / Ship To
                </strong>
                <p className="text-sm font-bold">{selectedOrder.customerName}</p>
                <p>{selectedOrder.customerPhone}</p>
                <p>{selectedOrder.customerEmail}</p>
                <p>
                  {selectedOrder.shippingAddress
                    ? `${selectedOrder.shippingAddress.street}, ${selectedOrder.shippingAddress.city}, ${selectedOrder.shippingAddress.countyOrState}, ${selectedOrder.shippingAddress.country}`
                    : 'No shipping address on file'}
                </p>
              </div>
              <div>
                <strong className="block text-[10px] text-fg-subtle uppercase">Payment</strong>
                <p>
                  Method:{' '}
                  <strong className="uppercase">
                    {selectedOrder.paymentMethod.replace(/_/g, ' ')}
                  </strong>
                </p>
                <p>
                  Reference:{' '}
                  <strong className="font-mono">
                    {shownPaymentReference(selectedOrder) || '—'}
                  </strong>
                </p>
                <p>
                  Courier: <strong>{selectedOrder.shippingCourier || 'Not assigned'}</strong>
                </p>
                <p>
                  Tracking:{' '}
                  <strong className="font-mono">{selectedOrder.trackingNumber || 'PENDING'}</strong>
                </p>
              </div>
            </div>

            <table className="w-full border border-line-strong text-left text-xs">
              <thead className="border-b border-line-strong bg-surface-sunken font-bold">
                <tr>
                  <th className="p-2">Item Description</th>
                  <th className="p-2 text-center">Qty</th>
                  <th className="p-2 text-right">Unit Price</th>
                  <th className="p-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line-strong">
                {selectedOrder.items.map((item, i) => (
                  <tr key={i}>
                    <td className="p-2">
                      <div className="font-semibold">{item.productName}</div>
                    </td>
                    <td className="p-2 text-center font-mono font-bold">{item.quantity}</td>
                    <td className="p-2 text-right font-mono">
                      {money(item.unitPrice, selectedOrder.currency)}
                    </td>
                    <td className="p-2 text-right font-mono font-bold">
                      {money(item.totalPrice, selectedOrder.currency)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="ml-auto w-full max-w-[220px] space-y-1 text-xs">
              <div className="flex justify-between text-fg-faint">
                <span>Subtotal</span>
                <span className="font-mono">
                  {money(selectedOrder.subtotal, selectedOrder.currency)}
                </span>
              </div>
              <div className="flex justify-between text-fg-faint">
                <span>VAT</span>
                <span className="font-mono">
                  {money(selectedOrder.tax, selectedOrder.currency)}
                </span>
              </div>
              <div className="flex justify-between text-fg-faint">
                <span>Shipping</span>
                <span className="font-mono">
                  {money(selectedOrder.shippingFee, selectedOrder.currency)}
                </span>
              </div>
              <div className="flex justify-between border-t border-line-strong pt-2 text-sm font-black">
                <span>Total</span>
                <span className="font-mono">
                  {money(selectedOrder.totalAmount, selectedOrder.currency)}
                </span>
              </div>
            </div>

            {company.invoiceFooterNote ? (
              <p className="border-t border-line-strong pt-3 text-[11px] text-fg-subtle">
                {company.invoiceFooterNote}
              </p>
            ) : null}

            <div className="flex flex-wrap justify-end gap-3 border-t border-line-strong pt-4">
              <button
                onClick={() => setIsPrintModalOpen(false)}
                className="cursor-pointer rounded-lg bg-surface-sunken px-4 py-2 text-xs font-bold text-fg-strong"
              >
                Close
              </button>
              <button
                type="button"
                disabled={invoiceBusy}
                onClick={() => {
                  if (selectedOrder) void handleEmailInvoice(selectedOrder.id, 'tax_invoice');
                }}
                className="cursor-pointer rounded-lg bg-indigo-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
              >
                Email Tax Invoice
              </button>
              <button
                type="button"
                disabled={invoiceBusy}
                onClick={() => {
                  if (selectedOrder) void handleDownloadInvoice(selectedOrder.id, 'tax_invoice');
                }}
                className="cursor-pointer rounded-lg bg-surface-raised px-4 py-2 text-xs font-bold text-fg-strong disabled:opacity-50"
              >
                Download Tax Invoice
              </button>
              {!isOrderPaid(selectedOrder) ? (
                <button
                  type="button"
                  disabled={invoiceBusy}
                  onClick={() => {
                    void handleDownloadInvoice(selectedOrder.id, 'proforma');
                  }}
                  className="cursor-pointer rounded-lg bg-amber-600 px-4 py-2 text-xs font-bold text-white disabled:opacity-50"
                >
                  Download Proforma
                </button>
              ) : null}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
