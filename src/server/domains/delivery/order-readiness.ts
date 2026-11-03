/** Why an order cannot be handed to the customer yet, in words, or null when it can. One rule for collecting and for delivering. */
export type ReadinessRefusal = 'order_closed' | 'on_hold' | 'not_paid';

export interface ReadinessProblem {
  reason: ReadinessRefusal;
  message: string;
}

export function orderReadinessProblem(order: { status: string; paymentStatus: string; approvalStatus: string | null; paymentMethod: string }): ReadinessProblem | null {
  if (order.status === 'cancelled' || order.status === 'refunded' || order.status === 'failed') {
    return { reason: 'order_closed', message: 'This order was cancelled or refunded, so it is not handed over.' };
  }
  if (order.approvalStatus === 'pending' || order.approvalStatus === 'rejected' || order.approvalStatus === 'draft') {
    return { reason: 'on_hold', message: 'This order is waiting for approval, so it is not handed over yet.' };
  }
  // A sale on account is paid later, on its invoice; every other order must be paid for first.
  if (order.paymentStatus !== 'paid' && order.paymentMethod !== 'on_account') {
    return { reason: 'not_paid', message: 'This order has not been paid for, so it is not handed over.' };
  }
  return null;
}
