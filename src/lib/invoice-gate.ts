/** Why a person who is not staff may not be given the tax invoice of this order yet, in words; null when they may. */
export function taxInvoiceRefusal(order: { status: string; paymentStatus: string; paymentMethod: string }): string | null {
  if (order.status === 'cancelled' || order.status === 'failed') return 'This order was not completed, so it has no tax invoice.';
  if (order.paymentMethod === 'on_account' || order.paymentMethod === 'pay_on_delivery') return null;
  if (['paid', 'reconciled', 'partially_paid', 'partially_refunded', 'refunded'].includes(order.paymentStatus)) return null;
  return 'The tax invoice is available once the order is paid.';
}
