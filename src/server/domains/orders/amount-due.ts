/**
 * What is still to be paid through a payment gateway: the order's total less what gift cards or
 * loyalty points already covered. Every place that asks a gateway for money, or compares a payment
 * with the order, uses this rather than the total.
 */
export function amountDue(order: { totalAmount: number; tenderedAmount?: number | null }): number {
  const due = order.totalAmount - (order.tenderedAmount ?? 0);
  return Math.max(0, Math.round((due + Number.EPSILON) * 100) / 100);
}
