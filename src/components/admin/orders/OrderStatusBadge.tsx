import { AlertCircle, CheckCircle2, Clock, Truck, XCircle } from 'lucide-react';
import type { OrderStatus } from '@/types/index';

const base =
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold';

/** An order's state as a small coloured label with an icon, so it is never told by colour alone. */
export function OrderStatusBadge({ status }: { status: OrderStatus }) {
  switch (status) {
    case 'delivered':
    case 'completed':
      return (
        <span className={`${base} border-emerald-800 bg-emerald-50/80 text-emerald-700`}>
          <CheckCircle2 className="h-3 w-3" aria-hidden /> Delivered
        </span>
      );
    case 'shipped':
      return (
        <span className={`${base} border-blue-800 bg-blue-50 text-blue-700`}>
          <Truck className="h-3 w-3" aria-hidden /> In Transit
        </span>
      );
    case 'processing':
      return (
        <span className={`${base} border-indigo-800 bg-indigo-50 text-indigo-700`}>
          <Clock className="h-3 w-3" aria-hidden /> Processing
        </span>
      );
    case 'pending':
      return (
        <span className={`${base} border-amber-800 bg-amber-50 text-amber-700`}>
          <AlertCircle className="h-3 w-3" aria-hidden /> Pending Payment
        </span>
      );
    case 'cancelled':
      return (
        <span className={`${base} border-red-800 bg-red-50 text-red-700`}>
          <XCircle className="h-3 w-3" aria-hidden /> Cancelled
        </span>
      );
    case 'failed':
    case 'refunded':
      return (
        <span className={`${base} border-line-strong bg-surface-sunken text-fg`}>
          {status === 'failed' ? 'Failed' : 'Refunded'}
        </span>
      );
  }
}
