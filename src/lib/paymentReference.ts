
import { has } from '@/lib/has';
/** The reference the provider assigned when the payment succeeded. Not a checkout-request id. */
export function shownPaymentReference(order: {
  paymentMethod?: string | null;
  transactionReference?: string | null;
  mpesaReceiptNumber?: string | null;
}): string | null {
  const receipt = order.mpesaReceiptNumber?.trim() || '';
  const stored = order.transactionReference?.trim() || '';
  const stk = order.paymentMethod === 'mpesa_daraja' || order.paymentMethod === 'kcb_buni';
  if (stk) {
    if (has(receipt)) return receipt;
    if (has(stored) && !stored.startsWith('ws_CO_')) return stored;
    return null;
  }
  if (stored.startsWith('ws_CO_')) return receipt || null;
  return stored || receipt || null;
}
