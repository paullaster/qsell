import { CheckCircle2, Package, Smartphone, ShieldCheck, Printer, ArrowRight, MapPin, Download } from 'lucide-react';
import { Order } from '../../types/index.js';

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
  onContinueShopping
}: OrderSuccessModalProps) {
  if (!isOpen || !order) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto bg-black/85 backdrop-blur-md p-4 sm:p-6 flex items-center justify-center">
      <div className="relative w-full max-w-2xl bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-8">
        {/* Header Ribbon */}
        <div className="bg-zinc-950 p-6 sm:p-8 text-center border-b border-zinc-800 relative">
          <div className="w-16 h-16 rounded-full bg-emerald-500/10 border border-emerald-500/20 flex items-center justify-center mx-auto text-emerald-400 mb-3 shadow-lg">
            <CheckCircle2 className="w-9 h-9" />
          </div>
          <h2 className="text-xl sm:text-2xl font-bold text-white tracking-tight">
            Order Successfully Placed & Confirmed!
          </h2>
          <p className="text-xs text-zinc-400 mt-1">
            Payment verified • Warehouse packaging and delivery dispatched
          </p>
        </div>

        {/* Invoice & Order Summary */}
        <div className="p-6 sm:p-8 space-y-6 bg-zinc-900">
          {/* Metadata Cards */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Order Number</span>
              <span className="font-mono font-bold text-white">{order.orderNumber}</span>
            </div>
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Payment Method</span>
              <span className="font-semibold text-indigo-400 uppercase text-[11px]">
                {order.paymentMethod === 'mpesa_daraja' ? 'M-Pesa STK' : 'Pesapal v3'}
              </span>
            </div>
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Receipt Ref</span>
              <span className="font-mono font-bold text-emerald-400">
                {order.mpesaReceiptNumber || order.pesapalTrackingId?.slice(0, 10) || 'CONFIRMED'}
              </span>
            </div>
            <div className="p-3 rounded-lg bg-zinc-950 border border-zinc-800">
              <span className="text-zinc-500 block text-[10px]">Status</span>
              <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 font-bold text-[10px]">
                RECONCILED
              </span>
            </div>
          </div>

          {/* Delivery Details */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2 text-xs">
            <div className="flex items-center gap-2 text-zinc-300 font-semibold">
              <MapPin className="w-4 h-4 text-indigo-400" />
              Delivery Destination
            </div>
            <p className="text-zinc-400 text-[11px] leading-relaxed">
              {order.customerName} ({order.customerPhone})<br />
              {order.shippingAddress.street}, {order.shippingAddress.city}, {order.shippingAddress.countyOrState}, {order.shippingAddress.country}
            </p>
          </div>

          {/* Items Purchased */}
          <div className="space-y-3">
            <h4 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider">
              Purchased Items
            </h4>
            <div className="divide-y divide-zinc-800 rounded-xl bg-zinc-950 border border-zinc-800 p-3">
              {order.items.map((item) => (
                <div key={item.productId} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-3 text-xs">
                  <div className="flex items-center gap-3">
                    <img
                      src={item.imageUrl}
                      alt={item.productName}
                      className="w-10 h-10 object-cover rounded-lg bg-zinc-900"
                      referrerPolicy="no-referrer"
                    />
                    <div>
                      <span className="text-white font-medium block truncate max-w-xs">{item.productName}</span>
                      <span className="text-[10px] text-zinc-500 font-mono">Qty: {item.quantity} × KES {item.unitPrice.toLocaleString()}</span>
                    </div>
                  </div>
                  <span className="font-mono font-semibold text-white">
                    KES {item.totalPrice.toLocaleString()}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Total Box */}
          <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 flex items-center justify-between">
            <div>
              <span className="text-xs text-zinc-400 block">Total Paid (VAT & Shipping Inclusive)</span>
              <span className="text-xl font-bold text-white font-mono">KES {order.totalAmount.toLocaleString()}</span>
            </div>
            <div className="text-right">
              <span className="text-[11px] text-emerald-400 font-mono block">eTIMS PIN: P051892011Z</span>
              <span className="text-[10px] text-zinc-500">Electronic Tax Invoice</span>
            </div>
          </div>

          {/* Actions */}
          <div className="flex flex-col sm:flex-row gap-3 pt-2">
            <button
              onClick={() => window.print()}
              className="flex-1 py-3 px-4 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 text-xs font-semibold flex items-center justify-center gap-2 border border-zinc-700 transition-colors cursor-pointer"
            >
              <Printer className="w-4 h-4" />
              Print Official Receipt
            </button>
            <button
              onClick={() => {
                onClose();
                onContinueShopping();
              }}
              className="flex-1 py-3 px-4 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white text-xs font-bold flex items-center justify-center gap-2 shadow-lg shadow-indigo-600/20 transition-colors cursor-pointer"
            >
              Continue Shopping
              <ArrowRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
