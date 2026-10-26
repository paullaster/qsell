'use client';

import { useModalKeys } from '@/components/ui/useModalKeys';
import { lineDisplay, lineFromRow, quantityWords } from '@/lib/unit-rules';
import React, { useState } from 'react';
import {
  Search,
  X,
  Package,
  Truck,
  CheckCircle2,
  Clock,
  AlertCircle,
  Smartphone,
  CreditCard,
  MapPin,
  Receipt,
  Printer,
  ArrowRight,
  ShieldCheck,
} from 'lucide-react';
import { type Order } from '@/types/index';
import { AppImage } from '@/components/ui/AppImage';
import { shownPaymentReference } from '@/lib/paymentReference';
import { lookupOrderAction } from '@/server/domains/orders/actions';

interface OrderTrackerModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Looks an order up on the server by order number AND the email or phone it
 * was placed with, so a visitor only ever sees an order they can already identify.
 */
export function OrderTrackerModal({ isOpen, onClose }: OrderTrackerModalProps) {
  // Opened fresh each time: nothing typed or found before is still there.
  return isOpen ? <OpenTracker onClose={onClose} /> : null;
}

function OpenTracker({ onClose }: { onClose: () => void }) {
  const dialogRef = useModalKeys<HTMLDivElement>(onClose);
  const [searchTerm, setSearchTerm] = useState('');
  const [contact, setContact] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [matchedOrder, setMatchedOrder] = useState<Order | null>(null);
  const [searchError, setSearchError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (searchTerm.trim() === '' || contact.trim() === '') return;

    setIsLoading(true);
    setSearchError('');
    setHasSearched(true);

    try {
      const found = await lookupOrderAction(searchTerm.trim().toUpperCase(), contact.trim());

      if (found) {
        setMatchedOrder(found);
      } else {
        setMatchedOrder(null);
        setSearchError(
          'No order matches that order number and contact. Check both and try again.',
        );
      }
    } catch (err: any) {
      setSearchError('Unable to load orders at this moment. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  const getTimelineSteps = (order: Order) => {
    const isPaid = order.paymentStatus === 'paid' || order.paymentStatus === 'reconciled';
    const isCompleted = order.status === 'completed';

    return [
      {
        title: 'Order Confirmed & Items Reserved',
        desc: 'Items allocated and prepared for packing in our warehouse',
        time: new Date(order.createdAt).toLocaleTimeString([], {
          hour: '2-digit',
          minute: '2-digit',
        }),
        completed: true,
        current: false,
      },
      {
        title: isPaid ? 'Payment Confirmed & Verified' : 'Awaiting Payment',
        desc: isPaid
          ? `Paid via ${order.paymentMethod === 'mpesa_daraja' ? 'M-Pesa' : 'Card / Bank'} (${shownPaymentReference(order) || 'Confirmed'})`
          : 'Pending customer payment completion',
        time: isPaid
          ? new Date(order.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          : 'Pending',
        completed: isPaid,
        current: !isPaid,
      },
      {
        title: 'Dispatched from Nairobi Warehouse Hub',
        desc: 'Inspected, quality verified, and packed with invoice',
        time: isPaid ? 'In Progress' : 'Queued',
        completed: isPaid || isCompleted,
        current: isPaid && !isCompleted,
      },
      {
        title: 'Courier Delivery to Your Doorstep',
        desc: `Delivery to ${order.shippingAddress.street}, ${order.shippingAddress.city}`,
        time: isCompleted ? 'Delivered' : 'Estimated Today',
        completed: isCompleted,
        current: false,
      },
    ];
  };

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-stretch justify-center overflow-y-auto bg-backdrop/85 p-0 backdrop-blur-md sm:items-center sm:p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tracker-title"
        className="relative flex min-h-dvh w-full max-w-2xl flex-col overflow-hidden border border-line bg-surface-raised shadow-2xl sm:my-4 sm:min-h-0 sm:max-h-[calc(100dvh-2rem)] sm:rounded-2xl lg:max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between gap-2 border-b border-line bg-surface p-4 sm:p-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-600/10 text-indigo-400 sm:h-10 sm:w-10">
              <Truck className="h-4 w-4 sm:h-5 sm:w-5" />
            </div>
            <div>
              <h2 id="tracker-title" className="text-base font-bold text-fg-strong">Track your order</h2>
              <p className="line-clamp-1 text-xs text-fg-muted sm:text-xs">
                Real-time status, dispatch timeline & eTIMS receipt
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex h-10 w-10 cursor-pointer items-center justify-center rounded-lg border border-line bg-surface-raised text-fg-muted transition-colors hover:text-fg-strong"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </button>
        </div>

        {/* Search Input Box */}
        <div className="border-b border-line bg-surface p-4 sm:p-6">
          <form onSubmit={handleSearch} className="space-y-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block text-xs font-medium text-fg">
                Order number
                <span className="relative mt-1 block">
                  <Search
                    className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-fg-subtle"
                    aria-hidden="true"
                  />
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    placeholder="e.g. ORD-2026-5348"
                    autoCapitalize="characters"
                    spellCheck={false}
                    className="h-11 w-full rounded-lg border border-line bg-surface-raised py-2.5 pr-3 pl-10 font-mono text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                    required
                  />
                </span>
              </label>
              <label className="block text-xs font-medium text-fg">
                Email or phone used at checkout
                <input
                  type="text"
                  inputMode="email"
                  autoComplete="email"
                  value={contact}
                  onChange={(e) => setContact(e.target.value)}
                  placeholder="you@example.com or 0712345678"
                  className="mt-1 h-11 w-full rounded-lg border border-line bg-surface-raised px-3 py-2.5 text-xs text-fg-strong placeholder-fg-subtle focus:border-indigo-500 focus:outline-none"
                  required
                />
              </label>
            </div>
            <div className="flex justify-end">
              <button
                type="submit"
                disabled={isLoading}
                className="flex min-h-11 w-full shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-lg bg-indigo-600 px-4 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-500 disabled:opacity-50 min-[420px]:w-auto min-[420px]:px-5"
              >
                {isLoading ? 'Searching...' : 'Track Order'}
              </button>
            </div>
            <p className="text-xs text-fg-subtle">
              Your order number is in your order confirmation. We ask for your email or phone
              too so nobody else can look up your order.
            </p>
          </form>
        </div>

        {/* Results Area */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-4 sm:space-y-6 sm:p-6">
          {searchError && (
            <div
              role="alert"
              className="flex items-center gap-3 rounded-xl border border-red-800/60 bg-red-50 p-4 text-xs text-red-700"
            >
              <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
              <span>{searchError}</span>
            </div>
          )}

          {!hasSearched && !matchedOrder && (
            <div className="space-y-3 py-12 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-surface-sunken text-fg-subtle">
                <Package className="h-7 w-7" />
              </div>
              <h3 className="text-sm font-semibold text-fg-strong">Instant Live Tracking</h3>
              <p className="mx-auto max-w-sm text-xs leading-relaxed text-fg-muted">
                Enter your order credentials above to view real-time dispatch progress, carrier
                location, and electronic invoice records.
              </p>
            </div>
          )}

          {matchedOrder && (
            <div className="animate-fade-in space-y-6">
              {/* Order Meta Header Banner */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-line bg-surface p-4">
                <div>
                  <span className="block font-mono text-xs text-fg-subtle uppercase">
                    Order Reference
                  </span>
                  <span className="font-mono text-base font-bold text-fg-strong">
                    {matchedOrder.orderNumber}
                  </span>
                </div>

                <div>
                  <span className="block font-mono text-xs text-fg-subtle uppercase">
                    Payment Status
                  </span>
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 font-mono text-xs font-bold ${
                      matchedOrder.paymentStatus === 'reconciled' ||
                      matchedOrder.paymentStatus === 'paid'
                        ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-600'
                        : 'border border-amber-500/20 bg-amber-500/10 text-amber-600'
                    }`}
                  >
                    {matchedOrder.paymentStatus.toUpperCase()}
                  </span>
                </div>

                <div>
                  <span className="block font-mono text-xs text-fg-subtle uppercase">
                    Order Total
                  </span>
                  <span className="font-mono text-sm font-bold text-fg-strong">
                    KES {matchedOrder.totalAmount.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Status Timeline */}
              <div className="space-y-3">
                <h4 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-indigo-400 uppercase">
                  <Clock className="h-4 w-4" /> Dispatch & Delivery Progress
                </h4>
                <div className="space-y-4 rounded-xl border border-line bg-surface p-4">
                  {getTimelineSteps(matchedOrder).map((step, idx) => (
                    <div key={idx} className="flex items-start gap-3.5">
                      <div className="flex flex-col items-center">
                        <div
                          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                            step.completed
                              ? 'bg-emerald-500 text-black shadow-sm shadow-emerald-500/50'
                              : step.current
                                ? 'TW animate-pulse bg-indigo-600'
                                : 'bg-surface-sunken text-fg-subtle'
                          }`}
                        >
                          {step.completed ? '✓' : idx + 1}
                        </div>
                        {idx < 3 && (
                          <div
                            className={`my-1 h-8 w-0.5 ${
                              step.completed ? 'bg-emerald-500/50' : 'bg-surface-sunken'
                            }`}
                          />
                        )}
                      </div>
                      <div className="-mt-0.5 flex-1">
                        <div className="flex items-center justify-between">
                          <h5
                            className={`text-xs font-semibold ${step.completed || step.current ? 'text-fg-strong' : 'text-fg-subtle'}`}
                          >
                            {step.title}
                          </h5>
                          <span className="font-mono text-xs text-fg-muted">{step.time}</span>
                        </div>
                        <p className="mt-0.5 text-xs text-fg-muted">{step.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Delivery Address & Customer Info */}
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <div className="space-y-1.5 rounded-xl border border-line bg-surface p-3.5 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-fg">
                    <MapPin className="h-3.5 w-3.5 text-indigo-400" /> Delivery Address
                  </div>
                  <p className="text-xs leading-relaxed text-fg-muted">
                    {matchedOrder.customerName}
                    <br />
                    {matchedOrder.shippingAddress.street}, {matchedOrder.shippingAddress.city}
                    <br />
                    {matchedOrder.shippingAddress.countyOrState},{' '}
                    {matchedOrder.shippingAddress.country}
                  </p>
                </div>

                <div className="space-y-1.5 rounded-xl border border-line bg-surface p-3.5 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-fg">
                    {matchedOrder.paymentMethod === 'mpesa_daraja' ? (
                      <Smartphone className="h-3.5 w-3.5 text-emerald-600" />
                    ) : (
                      <CreditCard className="h-3.5 w-3.5 text-indigo-400" />
                    )}
                    Payment Reconciliation
                  </div>
                  <p className="text-xs leading-relaxed text-fg-muted">
                    Method:{' '}
                    <span className="font-medium text-fg-strong">
                      {matchedOrder.paymentMethod === 'mpesa_daraja'
                        ? 'Safaricom M-Pesa STK'
                        : 'Pesapal v3.0'}
                    </span>
                    <br />
                    Ref:{' '}
                    <span className="font-mono text-emerald-600">
                      {shownPaymentReference(matchedOrder) || 'Confirmed'}
                    </span>
                    <br />
                    Phone: <span className="font-mono text-fg">{matchedOrder.customerPhone}</span>
                  </p>
                </div>
              </div>

              {/* Purchased Items List */}
              <div className="space-y-2">
                <span className="block text-xs font-bold tracking-wider text-fg-muted uppercase">
                  Items in Shipment ({matchedOrder.items.length})
                </span>
                <div className="divide-y divide-line rounded-xl border border-line bg-surface p-3">
                  {matchedOrder.items.map((item, i) => (
                    <div
                      key={i}
                      className="flex items-center justify-between py-2.5 text-xs first:pt-0 last:pb-0"
                    >
                      <div className="flex items-center gap-3">
                        <AppImage
                          src={item.imageUrl}
                          alt={item.productName}
                          width={36}
                          height={36}
                          sizes="36px"
                          className="h-9 w-9 shrink-0 rounded-lg bg-surface-raised object-cover"
                          referrerPolicy="no-referrer"
                        />
                        <div>
                          <div className="font-medium text-fg-strong">{item.productName}</div>
                          <div className="font-mono text-xs text-fg-subtle">
                            Qty: {quantityWords(lineFromRow(item))} × KES {lineDisplay(lineFromRow(item)).unitPrice.toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <span className="font-mono font-semibold text-fg-strong">
                        KES {item.totalPrice.toLocaleString()}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between border-t border-line bg-surface p-4 sm:p-5">
          <div className="flex items-center gap-1.5 text-xs text-fg-subtle">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-600" />
            eTIMS Compliant Tax Invoicing • Nairobi Fast Dispatch
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-surface-sunken px-4 py-2 text-xs font-medium text-fg-strong transition-colors hover:bg-hover"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
