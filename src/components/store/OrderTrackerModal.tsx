'use client';

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

interface OrderTrackerModalProps {
  isOpen: boolean;
  onClose: () => void;
  ordersPromise: Promise<Order[]>;
}

export function OrderTrackerModal({ isOpen, onClose, ordersPromise }: OrderTrackerModalProps) {
  const [searchTerm, setSearchTerm] = useState('');
  const [hasSearched, setHasSearched] = useState(false);
  const [matchedOrder, setMatchedOrder] = useState<Order | null>(null);
  const [searchError, setSearchError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  if (!isOpen) return null;

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!searchTerm.trim()) return;

    setIsLoading(true);
    setSearchError('');
    setHasSearched(true);

    try {
      const allOrders = await ordersPromise;
      const term = searchTerm.trim().toUpperCase();

      const found = allOrders.find(
        (o) =>
          o.orderNumber.toUpperCase() === term ||
          o.id.toUpperCase() === term ||
          (o.mpesaReceiptNumber && o.mpesaReceiptNumber.toUpperCase() === term) ||
          (shownPaymentReference(o)?.toUpperCase() === term) ||
          o.customerPhone.includes(searchTerm.trim()) ||
          o.customerEmail.toLowerCase() === searchTerm.trim().toLowerCase(),
      );

      if (found) {
        setMatchedOrder(found);
      } else {
        setMatchedOrder(null);
        setSearchError(
          `No order found matching "${searchTerm}". Please verify your Order ID or M-Pesa Receipt Number.`,
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
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center overflow-y-auto bg-black/85 p-4 backdrop-blur-md sm:p-6">
      <div className="relative my-8 flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-950 p-5 sm:p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl border border-indigo-500/20 bg-indigo-600/10 text-indigo-400">
              <Truck className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-bold text-white">Track Your Order</h2>
              <p className="text-xs text-zinc-400">
                Real-time status, dispatch timeline & eTIMS receipt
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-zinc-800 bg-zinc-900 p-2 text-zinc-400 transition-colors hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Search Input Box */}
        <div className="border-b border-zinc-800 bg-zinc-950 p-5 sm:p-6">
          <form onSubmit={handleSearch} className="space-y-3">
            <label className="block text-xs font-medium text-zinc-300">
              Enter Order Number, M-Pesa Receipt Code, or Phone Number
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute top-1/2 left-3.5 h-4 w-4 -translate-y-1/2 text-zinc-500" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="e.g. ORD-1740987654 or QJK4920194 or 0712345678"
                  className="w-full rounded-lg border border-zinc-800 bg-zinc-900 py-2.5 pr-4 pl-10 font-mono text-xs text-white placeholder-zinc-500 focus:border-indigo-500 focus:outline-none"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={isLoading}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-indigo-600 px-5 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
              >
                {isLoading ? 'Searching...' : 'Track Order'}
              </button>
            </div>
            <p className="text-[11px] text-zinc-500">
              Tip: You can find your Order Number in the SMS confirmation or on your M-Pesa
              transaction reference.
            </p>
          </form>
        </div>

        {/* Results Area */}
        <div className="flex-1 space-y-6 overflow-y-auto p-5 sm:p-6">
          {searchError && (
            <div className="flex items-center gap-3 rounded-xl border border-red-800/60 bg-red-950/40 p-4 text-xs text-red-300">
              <AlertCircle className="h-5 w-5 shrink-0 text-red-400" />
              <span>{searchError}</span>
            </div>
          )}

          {!hasSearched && !matchedOrder && (
            <div className="space-y-3 py-12 text-center">
              <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-full bg-zinc-800 text-zinc-500">
                <Package className="h-7 w-7" />
              </div>
              <h3 className="text-sm font-semibold text-white">Instant Live Tracking</h3>
              <p className="mx-auto max-w-sm text-xs leading-relaxed text-zinc-400">
                Enter your order credentials above to view real-time dispatch progress, carrier
                location, and electronic invoice records.
              </p>
            </div>
          )}

          {matchedOrder && (
            <div className="animate-fade-in space-y-6">
              {/* Order Meta Header Banner */}
              <div className="flex flex-wrap items-center justify-between gap-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                <div>
                  <span className="block font-mono text-[10px] text-zinc-500 uppercase">
                    Order Reference
                  </span>
                  <span className="font-mono text-base font-bold text-white">
                    {matchedOrder.orderNumber}
                  </span>
                </div>

                <div>
                  <span className="block font-mono text-[10px] text-zinc-500 uppercase">
                    Payment Status
                  </span>
                  <span
                    className={`inline-flex items-center rounded px-2 py-0.5 font-mono text-xs font-bold ${
                      matchedOrder.paymentStatus === 'reconciled' ||
                      matchedOrder.paymentStatus === 'paid'
                        ? 'border border-emerald-500/20 bg-emerald-500/10 text-emerald-400'
                        : 'border border-amber-500/20 bg-amber-500/10 text-amber-400'
                    }`}
                  >
                    {matchedOrder.paymentStatus.toUpperCase()}
                  </span>
                </div>

                <div>
                  <span className="block font-mono text-[10px] text-zinc-500 uppercase">
                    Order Total
                  </span>
                  <span className="font-mono text-sm font-bold text-white">
                    KES {matchedOrder.totalAmount.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Status Timeline */}
              <div className="space-y-3">
                <h4 className="flex items-center gap-1.5 text-xs font-bold tracking-wider text-indigo-400 uppercase">
                  <Clock className="h-4 w-4" /> Dispatch & Delivery Progress
                </h4>
                <div className="space-y-4 rounded-xl border border-zinc-800 bg-zinc-950 p-4">
                  {getTimelineSteps(matchedOrder).map((step, idx) => (
                    <div key={idx} className="flex items-start gap-3.5">
                      <div className="flex flex-col items-center">
                        <div
                          className={`flex h-6 w-6 items-center justify-center rounded-full text-xs font-bold ${
                            step.completed
                              ? 'bg-emerald-500 text-black shadow-sm shadow-emerald-500/50'
                              : step.current
                                ? 'animate-pulse bg-indigo-600 text-white'
                                : 'bg-zinc-800 text-zinc-500'
                          }`}
                        >
                          {step.completed ? '✓' : idx + 1}
                        </div>
                        {idx < 3 && (
                          <div
                            className={`my-1 h-8 w-0.5 ${
                              step.completed ? 'bg-emerald-500/50' : 'bg-zinc-800'
                            }`}
                          />
                        )}
                      </div>
                      <div className="-mt-0.5 flex-1">
                        <div className="flex items-center justify-between">
                          <h5
                            className={`text-xs font-semibold ${step.completed || step.current ? 'text-white' : 'text-zinc-500'}`}
                          >
                            {step.title}
                          </h5>
                          <span className="font-mono text-[10px] text-zinc-400">{step.time}</span>
                        </div>
                        <p className="mt-0.5 text-[11px] text-zinc-400">{step.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Delivery Address & Customer Info */}
              <div className="grid grid-cols-1 gap-3.5 sm:grid-cols-2">
                <div className="space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-950 p-3.5 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-zinc-300">
                    <MapPin className="h-3.5 w-3.5 text-indigo-400" /> Delivery Address
                  </div>
                  <p className="text-[11px] leading-relaxed text-zinc-400">
                    {matchedOrder.customerName}
                    <br />
                    {matchedOrder.shippingAddress.street}, {matchedOrder.shippingAddress.city}
                    <br />
                    {matchedOrder.shippingAddress.countyOrState},{' '}
                    {matchedOrder.shippingAddress.country}
                  </p>
                </div>

                <div className="space-y-1.5 rounded-xl border border-zinc-800 bg-zinc-950 p-3.5 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-zinc-300">
                    {matchedOrder.paymentMethod === 'mpesa_daraja' ? (
                      <Smartphone className="h-3.5 w-3.5 text-emerald-400" />
                    ) : (
                      <CreditCard className="h-3.5 w-3.5 text-indigo-400" />
                    )}
                    Payment Reconciliation
                  </div>
                  <p className="text-[11px] leading-relaxed text-zinc-400">
                    Method:{' '}
                    <span className="font-medium text-white">
                      {matchedOrder.paymentMethod === 'mpesa_daraja'
                        ? 'Safaricom M-Pesa STK'
                        : 'Pesapal v3.0'}
                    </span>
                    <br />
                    Ref:{' '}
                    <span className="font-mono text-emerald-400">
                      {shownPaymentReference(matchedOrder) || 'Confirmed'}
                    </span>
                    <br />
                    Phone:{' '}
                    <span className="font-mono text-zinc-300">{matchedOrder.customerPhone}</span>
                  </p>
                </div>
              </div>

              {/* Purchased Items List */}
              <div className="space-y-2">
                <span className="block text-xs font-bold tracking-wider text-zinc-400 uppercase">
                  Items in Shipment ({matchedOrder.items.length})
                </span>
                <div className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-950 p-3">
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
                          className="h-9 w-9 shrink-0 rounded-lg bg-zinc-900 object-cover"
                          referrerPolicy="no-referrer"
                        />
                        <div>
                          <div className="font-medium text-white">{item.productName}</div>
                          <div className="font-mono text-[10px] text-zinc-500">
                            Qty: {item.quantity} × KES {item.unitPrice.toLocaleString()}
                          </div>
                        </div>
                      </div>
                      <span className="font-mono font-semibold text-white">
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
        <div className="flex items-center justify-between border-t border-zinc-800 bg-zinc-950 p-4 sm:p-5">
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <ShieldCheck className="h-3.5 w-3.5 text-emerald-400" />
            eTIMS Compliant Tax Invoicing • Nairobi Fast Dispatch
          </div>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-lg bg-zinc-800 px-4 py-2 text-xs font-medium text-white transition-colors hover:bg-zinc-700"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
