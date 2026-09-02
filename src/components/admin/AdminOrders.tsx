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
  ExternalLink
} from 'lucide-react';
import { Order, OrderStatus } from '../../types/index.js';
import { updateOrderStatusAction, cancelOrderAction } from '../../lib/serverActions.js';

interface AdminOrdersProps {
  ordersPromise: Promise<Order[]>;
  onRefresh: () => void;
}

export function AdminOrders({ ordersPromise, onRefresh }: AdminOrdersProps) {
  const orders = use(ordersPromise);

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

  // Filter Orders
  const filteredOrders = orders.filter((o) => {
    const matchesSearch =
      o.orderNumber.toLowerCase().includes(search.toLowerCase()) ||
      o.customerName.toLowerCase().includes(search.toLowerCase()) ||
      o.customerPhone.toLowerCase().includes(search.toLowerCase()) ||
      o.customerEmail.toLowerCase().includes(search.toLowerCase()) ||
      (o.trackingNumber && o.trackingNumber.toLowerCase().includes(search.toLowerCase()));

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
        internalNotes: internalNotes.trim() || undefined
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
    if (window.confirm(`Are you sure you want to cancel order ${selectedOrder.orderNumber}? This will automatically return all reserved inventory items back to active stock.`)) {
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
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-emerald-950/80 text-emerald-300 border border-emerald-800">
            <CheckCircle2 className="w-3 h-3" /> Delivered
          </span>
        );
      case 'shipped':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-blue-950 text-blue-300 border border-blue-800">
            <Truck className="w-3 h-3" /> In Transit
          </span>
        );
      case 'processing':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-indigo-950 text-indigo-300 border border-indigo-800">
            <Clock className="w-3 h-3" /> Processing
          </span>
        );
      case 'pending':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-amber-950 text-amber-300 border border-amber-800">
            <AlertCircle className="w-3 h-3" /> Pending Payment
          </span>
        );
      case 'cancelled':
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-red-950 text-red-300 border border-red-800">
            <XCircle className="w-3 h-3" /> Cancelled
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-[11px] font-semibold bg-zinc-800 text-zinc-300 border border-zinc-700">
            {status}
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      {/* Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-5 rounded-xl bg-zinc-900 border border-zinc-800">
        <div>
          <h2 className="font-bold text-base text-white flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-indigo-400" />
            Customer Orders & Shipment Processing
          </h2>
          <p className="text-xs text-zinc-400 mt-0.5">
            Review incoming customer orders, assign courier delivery tracking, print packing slips, and manage cancellations with automatic stock return.
          </p>
        </div>

        <button
          onClick={onRefresh}
          className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white text-xs font-semibold transition-colors cursor-pointer w-fit"
        >
          <RefreshCw className="w-3.5 h-3.5" />
          Refresh Orders
        </button>
      </div>

      {/* Filter and Search */}
      <div className="p-4 rounded-xl bg-zinc-900 border border-zinc-800 flex flex-col sm:flex-row items-center justify-between gap-3 text-xs">
        <div className="relative w-full sm:w-80">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-zinc-500" />
          <input
            type="text"
            placeholder="Search Order #, customer name, phone, tracking..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full bg-zinc-950 border border-zinc-800 rounded-lg pl-9 pr-4 py-1.5 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
          />
        </div>

        <div className="flex items-center gap-2 w-full sm:w-auto">
          <span className="text-zinc-500">Status:</span>
          <select
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="bg-zinc-950 border border-zinc-800 rounded-lg px-3 py-1.5 text-white focus:outline-none focus:border-indigo-500 cursor-pointer text-xs"
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
      <div className="rounded-xl bg-zinc-900 border border-zinc-800 overflow-hidden shadow-xl">
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-950 text-zinc-400 font-semibold border-b border-zinc-800">
              <tr>
                <th className="py-3 px-4">Order #</th>
                <th className="py-3 px-4">Date</th>
                <th className="py-3 px-4">Customer</th>
                <th className="py-3 px-4 text-center">Items</th>
                <th className="py-3 px-4 text-right">Total Amount</th>
                <th className="py-3 px-4 text-center">Payment Info</th>
                <th className="py-3 px-4 text-center">Status</th>
                <th className="py-3 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800 text-zinc-300">
              {filteredOrders.length === 0 ? (
                <tr>
                  <td colSpan={8} className="py-10 text-center text-zinc-500">
                    No orders match the current filter criteria.
                  </td>
                </tr>
              ) : (
                filteredOrders.map((o) => (
                  <tr key={o.id} className="hover:bg-zinc-800/40 transition-colors">
                    <td className="py-3.5 px-4 font-mono font-bold text-white">
                      {o.orderNumber}
                    </td>
                    <td className="py-3.5 px-4 text-zinc-400 text-[11px]">
                      {new Date(o.createdAt).toLocaleDateString()} {new Date(o.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </td>
                    <td className="py-3.5 px-4">
                      <div className="font-semibold text-white">{o.customerName}</div>
                      <div className="text-[11px] text-zinc-400 font-mono">{o.customerPhone}</div>
                    </td>
                    <td className="py-3.5 px-4 text-center font-mono font-bold text-zinc-300">
                      {o.items.reduce((acc, i) => acc + i.quantity, 0)}
                    </td>
                    <td className="py-3.5 px-4 text-right font-mono font-bold text-white">
                      KES {o.totalAmount.toLocaleString()}
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      <div className="inline-flex flex-col items-center">
                        <span className="px-2 py-0.5 rounded bg-zinc-800 text-zinc-300 font-mono text-[10px] uppercase font-bold">
                          {o.paymentMethod}
                        </span>
                        {o.paymentReference && (
                          <span className="text-[9px] text-zinc-500 font-mono mt-0.5 truncate max-w-[100px]" title={o.paymentReference}>
                            Ref: {o.paymentReference}
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="py-3.5 px-4 text-center">
                      {getStatusBadge(o.status)}
                    </td>
                    <td className="py-3.5 px-4 text-right">
                      <button
                        onClick={() => openOrderDrawer(o)}
                        className="px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-200 hover:text-white font-medium text-xs cursor-pointer border border-zinc-700 transition-colors"
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
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/80 backdrop-blur-md p-4 sm:p-6 flex items-center justify-center">
          <div className="relative w-full max-w-3xl bg-zinc-900 border border-zinc-800 rounded-2xl overflow-hidden shadow-2xl flex flex-col my-8 max-h-[92vh] text-xs">
            {/* Modal Header */}
            <div className="p-5 border-b border-zinc-800 flex items-center justify-between bg-zinc-950">
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-indigo-600/20 border border-indigo-500/30 flex items-center justify-center text-indigo-400">
                  <ShoppingBag className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="font-bold text-base text-white">
                    Order Details: {selectedOrder.orderNumber}
                  </h3>
                  <p className="text-[11px] text-zinc-400">
                    Placed on {new Date(selectedOrder.createdAt).toLocaleString()}
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => setIsPrintModalOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-zinc-300 hover:text-white cursor-pointer"
                >
                  <Printer className="w-3.5 h-3.5" />
                  Print Packing Slip
                </button>
                <button 
                  onClick={() => setSelectedOrder(null)} 
                  className="text-zinc-400 hover:text-white p-1 rounded-lg cursor-pointer"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Modal Body */}
            <div className="p-6 overflow-y-auto space-y-6 flex-1">
              {actionError && (
                <div className="p-3.5 rounded-lg bg-red-950 border border-red-800 text-red-200">
                  {actionError}
                </div>
              )}

              {/* Status and Customer Overview */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                {/* Customer Details */}
                <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
                  <h4 className="font-bold text-white flex items-center gap-1.5 text-xs text-zinc-400 uppercase tracking-wider">
                    <User className="w-3.5 h-3.5 text-indigo-400" />
                    Customer & Delivery Address
                  </h4>
                  <div className="space-y-1 text-zinc-300">
                    <div className="font-bold text-white text-sm">{selectedOrder.customerName}</div>
                    <div className="flex items-center gap-2 font-mono text-[11px] text-zinc-400">
                      <Phone className="w-3 h-3 text-zinc-500" />
                      {selectedOrder.customerPhone}
                    </div>
                    <div className="flex items-center gap-2 text-[11px] text-zinc-400">
                      <Mail className="w-3 h-3 text-zinc-500" />
                      {selectedOrder.customerEmail}
                    </div>
                    <div className="flex items-start gap-2 text-[11px] text-zinc-300 pt-1">
                      <MapPin className="w-3.5 h-3.5 text-zinc-500 shrink-0 mt-0.5" />
                      <span>{selectedOrder.shippingAddress || 'Nairobi Central CBD, Kenya'}</span>
                    </div>
                  </div>
                </div>

                {/* Payment Overview */}
                <div className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-2">
                  <h4 className="font-bold text-white flex items-center gap-1.5 text-xs text-zinc-400 uppercase tracking-wider">
                    <DollarSign className="w-3.5 h-3.5 text-emerald-400" />
                    Payment & Settlement
                  </h4>
                  <div className="space-y-1.5 text-zinc-300">
                    <div className="flex justify-between items-center">
                      <span className="text-zinc-400">Method:</span>
                      <span className="font-bold text-white uppercase font-mono">{selectedOrder.paymentMethod}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-zinc-400">Reference:</span>
                      <span className="font-mono text-zinc-200">{selectedOrder.paymentReference || 'N/A'}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-zinc-400">Current Status:</span>
                      {getStatusBadge(selectedOrder.status)}
                    </div>
                    <div className="flex justify-between items-center pt-2 border-t border-zinc-800 font-bold text-white">
                      <span>Total Amount:</span>
                      <span className="text-sm font-mono text-emerald-400">KES {selectedOrder.totalAmount.toLocaleString()}</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Itemized Order Line Items */}
              <div className="space-y-2">
                <h4 className="font-bold text-white text-xs uppercase tracking-wider text-zinc-400">
                  Itemized Line Items ({selectedOrder.items.length})
                </h4>
                <div className="rounded-xl bg-zinc-950 border border-zinc-800 overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-zinc-900 text-zinc-400 border-b border-zinc-800">
                      <tr>
                        <th className="py-2.5 px-4">Item & SKU</th>
                        <th className="py-2.5 px-4 text-right">Unit Price</th>
                        <th className="py-2.5 px-4 text-center">Qty</th>
                        <th className="py-2.5 px-4 text-right">Subtotal</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800 text-zinc-300">
                      {selectedOrder.items.map((item, idx) => (
                        <tr key={idx}>
                          <td className="py-3 px-4 font-medium text-white">
                            {item.productName}
                            <div className="text-[10px] text-zinc-400 font-mono">{item.sku}</div>
                          </td>
                          <td className="py-3 px-4 text-right font-mono">
                            KES {item.price.toLocaleString()}
                          </td>
                          <td className="py-3 px-4 text-center font-mono font-bold">
                            {item.quantity}
                          </td>
                          <td className="py-3 px-4 text-right font-mono font-bold text-white">
                            KES {(item.price * item.quantity).toLocaleString()}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* Fulfillment Status Management Form */}
              <form onSubmit={handleUpdateStatus} className="p-4 rounded-xl bg-zinc-950 border border-zinc-800 space-y-4">
                <h4 className="font-bold text-white flex items-center gap-1.5 text-xs text-zinc-400 uppercase tracking-wider">
                  <Truck className="w-3.5 h-3.5 text-indigo-400" />
                  Update Order Fulfillment Lifecycle
                </h4>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                  <div>
                    <label className="block font-semibold text-zinc-300 mb-1">Update Status</label>
                    <select
                      value={newStatus}
                      onChange={(e) => setNewStatus(e.target.value as OrderStatus)}
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:border-indigo-500 cursor-pointer"
                    >
                      <option value="pending">Pending Payment</option>
                      <option value="processing">Processing / Order Confirmed</option>
                      <option value="shipped">Dispatched / In Transit</option>
                      <option value="delivered">Delivered to Customer</option>
                      <option value="cancelled">Cancelled (Restock)</option>
                    </select>
                  </div>

                  <div>
                    <label className="block font-semibold text-zinc-300 mb-1">Shipping Courier</label>
                    <input
                      type="text"
                      value={shippingCourier}
                      onChange={(e) => setShippingCourier(e.target.value)}
                      placeholder="e.g. Wells Fargo, G4S Kenya"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:border-indigo-500"
                    />
                  </div>

                  <div>
                    <label className="block font-semibold text-zinc-300 mb-1">Courier Tracking Code</label>
                    <input
                      type="text"
                      value={trackingNumber}
                      onChange={(e) => setTrackingNumber(e.target.value)}
                      placeholder="WF-984210"
                      className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-white font-mono focus:border-indigo-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block font-semibold text-zinc-300 mb-1">Internal Fulfillment Staff Notes</label>
                  <input
                    type="text"
                    value={internalNotes}
                    onChange={(e) => setInternalNotes(e.target.value)}
                    placeholder="e.g. Verified payment with M-Pesa statements, dispatched via rider #4"
                    className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-2 text-white focus:border-indigo-500"
                  />
                </div>

                <div className="flex items-center justify-between pt-2">
                  <button
                    type="button"
                    onClick={handleCancelOrder}
                    disabled={selectedOrder.status === 'cancelled' || isSubmitting}
                    className="px-3 py-1.5 rounded-lg bg-red-950 hover:bg-red-900 text-red-300 border border-red-800 font-semibold cursor-pointer disabled:opacity-40"
                  >
                    Cancel Order & Restock
                  </button>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="px-5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-bold cursor-pointer shadow-lg shadow-indigo-600/20"
                  >
                    {isSubmitting ? 'Saving...' : 'Save Fulfillment Changes'}
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}

      {/* Printable Slip Modal */}
      {isPrintModalOpen && selectedOrder && (
        <div className="fixed inset-0 z-50 overflow-y-auto bg-black/90 p-4 flex items-center justify-center">
          <div className="w-full max-w-xl bg-white text-zinc-900 p-8 rounded-xl space-y-6 shadow-2xl">
            <div className="flex justify-between items-start border-b border-zinc-300 pb-4">
              <div>
                <h1 className="text-xl font-black tracking-tight">OMNICOMMERCE KENYA</h1>
                <p className="text-xs text-zinc-600">Enterprise Warehouse Fulfillment & Packing Slip</p>
              </div>
              <div className="text-right">
                <span className="font-mono font-bold text-sm block">#{selectedOrder.orderNumber}</span>
                <span className="text-xs text-zinc-500">{new Date(selectedOrder.createdAt).toLocaleDateString()}</span>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-4 text-xs">
              <div>
                <strong className="block text-zinc-500 uppercase text-[10px]">Ship To:</strong>
                <p className="font-bold text-sm">{selectedOrder.customerName}</p>
                <p>{selectedOrder.customerPhone}</p>
                <p>{selectedOrder.customerEmail}</p>
                <p>{selectedOrder.shippingAddress || 'Nairobi Central CBD, Kenya'}</p>
              </div>
              <div>
                <strong className="block text-zinc-500 uppercase text-[10px]">Dispatch Details:</strong>
                <p>Courier: <strong>{selectedOrder.shippingCourier || 'Standard Dispatch'}</strong></p>
                <p>Tracking: <strong className="font-mono">{selectedOrder.trackingNumber || 'PENDING'}</strong></p>
                <p>Payment: <strong>{selectedOrder.paymentMethod} (Ref: {selectedOrder.paymentReference || 'Confirmed'})</strong></p>
              </div>
            </div>

            <table className="w-full text-left text-xs border border-zinc-300">
              <thead className="bg-zinc-100 border-b border-zinc-300 font-bold">
                <tr>
                  <th className="p-2">Item Description</th>
                  <th className="p-2 text-center">Qty</th>
                  <th className="p-2 text-right">Unit Price</th>
                  <th className="p-2 text-right">Total</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-200">
                {selectedOrder.items.map((item, i) => (
                  <tr key={i}>
                    <td className="p-2">
                      <div className="font-semibold">{item.productName}</div>
                      <div className="text-[10px] text-zinc-500 font-mono">{item.sku}</div>
                    </td>
                    <td className="p-2 text-center font-bold font-mono">{item.quantity}</td>
                    <td className="p-2 text-right font-mono">KES {item.price.toLocaleString()}</td>
                    <td className="p-2 text-right font-bold font-mono">KES {(item.price * item.quantity).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            <div className="flex justify-between items-center pt-2 border-t border-zinc-300">
              <span className="text-xs text-zinc-500">Thank you for ordering with OmniCommerce Kenya.</span>
              <div className="text-right">
                <span className="text-xs text-zinc-500 block">Total Due / Paid:</span>
                <span className="text-lg font-black font-mono">KES {selectedOrder.totalAmount.toLocaleString()}</span>
              </div>
            </div>

            <div className="flex justify-end gap-3 pt-4 border-t border-zinc-200">
              <button
                onClick={() => setIsPrintModalOpen(false)}
                className="px-4 py-2 rounded-lg bg-zinc-200 text-zinc-800 text-xs font-bold cursor-pointer"
              >
                Close
              </button>
              <button
                onClick={() => window.print()}
                className="px-4 py-2 rounded-lg bg-zinc-900 text-white text-xs font-bold cursor-pointer"
              >
                Print Slip
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
