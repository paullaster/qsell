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
  ShieldCheck
} from 'lucide-react';
import { Order } from '@/types/index';

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
      
      const found = allOrders.find(o => 
        o.orderNumber.toUpperCase() === term ||
        o.id.toUpperCase() === term ||
        (o.mpesaReceiptNumber && o.mpesaReceiptNumber.toUpperCase() === term) ||
        o.customerPhone.includes(searchTerm.trim()) ||
        o.customerEmail.toLowerCase() === searchTerm.trim().toLowerCase()
      );

      if (found) {
        setMatchedOrder(found);
      } else {
        setMatchedOrder(null);
        setSearchError(`No order found matching "${searchTerm}". Please verify your Order ID or M-Pesa Receipt Number.`);
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
        time: new Date(order.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        completed: true,
        current: false
      },
      {
        title: isPaid ? 'Payment Confirmed & Verified' : 'Awaiting Payment',
        desc: isPaid 
          ? `Paid via ${order.paymentMethod === 'mpesa_daraja' ? 'M-Pesa' : 'Card / Bank'} (${order.mpesaReceiptNumber || 'Confirmed'})`
          : 'Pending customer payment completion',
        time: isPaid ? new Date(order.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'Pending',
        completed: isPaid,
        current: !isPaid
      },
      {
        title: 'Dispatched from Nairobi Warehouse Hub',
        desc: 'Inspected, quality verified, and packed with invoice',
        time: isPaid ? 'In Progress' : 'Queued',
        completed: isPaid || isCompleted,
        current: isPaid && !isCompleted
      },
      {
        title: 'Courier Delivery to Your Doorstep',
        desc: `Delivery to ${order.shippingAddress.street}, ${order.shippingAddress.city}`,
        time: isCompleted ? 'Delivered' : 'Estimated Today',
        completed: isCompleted,
        current: false
      }
    ];
  };

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/85 backdrop-blur-md p-4 sm:p-6 flex items-center justify-center animate-fade-in">
      <div className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-8 max-h-[90vh]">
        {/* Header */}
        <div className="p-5 sm:p-6 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-indigo-600/10 border border-indigo-500/20 flex items-center justify-center text-indigo-400">
              <Truck className="w-5 h-5" />
            </div>
            <div>
              <h2 className="font-bold text-base text-white">Track Your Order</h2>
              <p className="text-xs text-zinc-400">Real-time status, dispatch timeline & eTIMS receipt</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 rounded-lg text-zinc-400 hover:text-white bg-zinc-900 border border-zinc-800 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Search Input Box */}
        <div className="p-5 sm:p-6 bg-zinc-950 border-b border-zinc-800">
          <form onSubmit={handleSearch} className="space-y-3">
            <label className="block text-xs font-medium text-zinc-300">
              Enter Order Number, M-Pesa Receipt Code, or Phone Number
            </label>
            <div className="flex gap-2">
              <div className="relative flex-1">
                <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
                <input
                  type="text"
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  placeholder="e.g. ORD-1740987654 or QJK4920194 or 0712345678"
                  className="w-full bg-zinc-900 border border-zinc-800 rounded-lg pl-10 pr-4 py-2.5 text-xs text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono"
                  required
                />
              </div>
              <button
                type="submit"
                disabled={isLoading}
                className="px-5 py-2.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-semibold text-xs transition-colors cursor-pointer disabled:opacity-50 flex items-center gap-1.5 shrink-0"
              >
                {isLoading ? 'Searching...' : 'Track Order'}
              </button>
            </div>
            <p className="text-[11px] text-zinc-500">
              Tip: You can find your Order Number in the SMS confirmation or on your M-Pesa transaction reference.
            </p>
          </form>
        </div>

        {/* Results Area */}
        <div className="flex-1 overflow-y-auto p-5 sm:p-6 space-y-6">
          {searchError && (
            <div className="p-4 rounded-xl bg-red-950/40 border border-red-800/60 text-red-300 text-xs flex items-center gap-3">
              <AlertCircle className="w-5 h-5 text-red-400 shrink-0" />
              <span>{searchError}</span>
            </div>
          )}

          {!hasSearched && !matchedOrder && (
            <div className="text-center py-12 space-y-3">
              <div className="w-14 h-14 rounded-full bg-zinc-800 flex items-center justify-center mx-auto text-zinc-500">
                <Package className="w-7 h-7" />
              </div>
              <h3 className="font-semibold text-white text-sm">Instant Live Tracking</h3>
              <p className="text-xs text-zinc-400 max-w-sm mx-auto leading-relaxed">
                Enter your order credentials above to view real-time dispatch progress, carrier location, and electronic invoice records.
              </p>
            </div>
          )}

          {matchedOrder && (
            <div className="space-y-6 animate-fade-in">
              {/* Order Meta Header Banner */}
              <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 flex flex-wrap items-center justify-between gap-4">
                <div>
                  <span className="text-[10px] text-zinc-500 uppercase font-mono block">Order Reference</span>
                  <span className="text-base font-bold text-white font-mono">{matchedOrder.orderNumber}</span>
                </div>

                <div>
                  <span className="text-[10px] text-zinc-500 uppercase font-mono block">Payment Status</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-bold font-mono ${
                    matchedOrder.paymentStatus === 'reconciled' || matchedOrder.paymentStatus === 'paid'
                      ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/20'
                      : 'bg-amber-500/10 text-amber-400 border border-amber-500/20'
                  }`}>
                    {matchedOrder.paymentStatus.toUpperCase()}
                  </span>
                </div>

                <div>
                  <span className="text-[10px] text-zinc-500 uppercase font-mono block">Order Total</span>
                  <span className="text-sm font-bold text-white font-mono">
                    KES {matchedOrder.totalAmount.toLocaleString()}
                  </span>
                </div>
              </div>

              {/* Status Timeline */}
              <div className="space-y-3">
                <h4 className="text-xs font-bold uppercase tracking-wider text-indigo-400 flex items-center gap-1.5">
                  <Clock className="w-4 h-4" /> Dispatch & Delivery Progress
                </h4>
                <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-4">
                  {getTimelineSteps(matchedOrder).map((step, idx) => (
                    <div key={idx} className="flex gap-3.5 items-start">
                      <div className="flex flex-col items-center">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${
                          step.completed 
                            ? 'bg-emerald-500 text-black shadow-sm shadow-emerald-500/50' 
                            : step.current 
                              ? 'bg-indigo-600 text-white animate-pulse' 
                              : 'bg-zinc-800 text-zinc-500'
                        }`}>
                          {step.completed ? '✓' : idx + 1}
                        </div>
                        {idx < 3 && (
                          <div className={`w-0.5 h-8 my-1 ${
                            step.completed ? 'bg-emerald-500/50' : 'bg-zinc-800'
                          }`} />
                        )}
                      </div>
                      <div className="flex-1 -mt-0.5">
                        <div className="flex items-center justify-between">
                          <h5 className={`text-xs font-semibold ${step.completed || step.current ? 'text-white' : 'text-zinc-500'}`}>
                            {step.title}
                          </h5>
                          <span className="text-[10px] font-mono text-zinc-400">{step.time}</span>
                        </div>
                        <p className="text-[11px] text-zinc-400 mt-0.5">{step.desc}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Delivery Address & Customer Info */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1.5 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-zinc-300">
                    <MapPin className="w-3.5 h-3.5 text-indigo-400" /> Delivery Address
                  </div>
                  <p className="text-zinc-400 text-[11px] leading-relaxed">
                    {matchedOrder.customerName}<br />
                    {matchedOrder.shippingAddress.street}, {matchedOrder.shippingAddress.city}<br />
                    {matchedOrder.shippingAddress.countyOrState}, {matchedOrder.shippingAddress.country}
                  </p>
                </div>

                <div className="p-3.5 rounded-xl bg-zinc-950 border border-zinc-800 space-y-1.5 text-xs">
                  <div className="flex items-center gap-1.5 font-semibold text-zinc-300">
                    {matchedOrder.paymentMethod === 'mpesa_daraja' ? (
                      <Smartphone className="w-3.5 h-3.5 text-emerald-400" />
                    ) : (
                      <CreditCard className="w-3.5 h-3.5 text-indigo-400" />
                    )}
                    Payment Reconciliation
                  </div>
                  <p className="text-zinc-400 text-[11px] leading-relaxed">
                    Method: <span className="text-white font-medium">{matchedOrder.paymentMethod === 'mpesa_daraja' ? 'Safaricom M-Pesa STK' : 'Pesapal v3.0'}</span><br />
                    Ref: <span className="font-mono text-emerald-400">{matchedOrder.mpesaReceiptNumber || matchedOrder.pesapalTrackingId || 'Confirmed'}</span><br />
                    Phone: <span className="font-mono text-zinc-300">{matchedOrder.customerPhone}</span>
                  </p>
                </div>
              </div>

              {/* Purchased Items List */}
              <div className="space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-zinc-400 block">
                  Items in Shipment ({matchedOrder.items.length})
                </span>
                <div className="divide-y divide-zinc-800 rounded-xl bg-zinc-950 border border-zinc-800 p-3">
                  {matchedOrder.items.map((item, i) => (
                    <div key={i} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between text-xs">
                      <div className="flex items-center gap-3">
                        <img 
                          src={item.imageUrl} 
                          alt={item.productName} 
                          className="w-9 h-9 object-cover rounded-lg bg-zinc-900 shrink-0" 
                          referrerPolicy="no-referrer"
                        />
                        <div>
                          <div className="font-medium text-white">{item.productName}</div>
                          <div className="text-[10px] text-zinc-500 font-mono">Qty: {item.quantity} × KES {item.unitPrice.toLocaleString()}</div>
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
        <div className="p-4 sm:p-5 border-t border-zinc-800 bg-zinc-950 flex items-center justify-between">
          <div className="flex items-center gap-1.5 text-[11px] text-zinc-500">
            <ShieldCheck className="w-3.5 h-3.5 text-emerald-400" />
            eTIMS Compliant Tax Invoicing • Nairobi Fast Dispatch
          </div>
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-white font-medium text-xs transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
