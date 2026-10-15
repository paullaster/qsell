
import { has } from '@/lib/has';
import { emptyToNull, firstFilled, orElse } from '@/lib/values';
/** The reference the provider assigned when the payment succeeded. Not a checkout-request id. */
export function shownPaymentReference(order: {
  paymentMethod?: string | null;
  transactionReference?: string | null;
  mpesaReceiptNumber?: string | null;
}): string | null {
  const receipt = orElse(order.mpesaReceiptNumber?.trim(), '');
  const stored = orElse(order.transactionReference?.trim(), '');
  const stk = order.paymentMethod === 'mpesa_daraja' || order.paymentMethod === 'kcb_buni';
  if (stk) {
    if (has(receipt)) return receipt;
    if (has(stored) && !stored.startsWith('ws_CO_')) return stored;
    return null;
  }
  if (stored.startsWith('ws_CO_')) return emptyToNull(receipt);
  return firstFilled(stored, receipt);
}
