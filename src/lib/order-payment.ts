/**
 * How money received against an order's invoice moves the order's payment state. Pure: the server gathers the figures
 * (what the invoices total, what receipts have settled) and this says where the order should be and which stage gets it there.
 */

/** When a cheque counts toward an order being paid: once it has cleared at the bank (the safe default), or as soon as it is received. */
export const CHEQUE_COUNTS_MODES = ['on_clearing', 'on_receipt'] as const;
export type ChequeCountsMode = (typeof CHEQUE_COUNTS_MODES)[number];
export const DEFAULT_CHEQUE_COUNTS: ChequeCountsMode = 'on_clearing';

export const CHEQUE_COUNTS_CHOICES: readonly { id: ChequeCountsMode; label: string }[] = [
  { id: 'on_clearing', label: 'When the cheque clears' },
  { id: 'on_receipt', label: 'As soon as the cheque is received' },
];

export const isChequeCountsMode = (value: unknown): value is ChequeCountsMode =>
  typeof value === 'string' && (CHEQUE_COUNTS_MODES as readonly string[]).includes(value);

export type SettledState = 'unpaid' | 'partially_paid' | 'paid';

/** Where an order stands, given the cents its invoices total and the cents receipts have settled. An order with nothing invoiced is not decided here. */
export function settledState(invoicedCents: number, settledCents: number): SettledState | null {
  if (invoicedCents <= 0) return null;
  if (settledCents <= 0) return 'unpaid';
  return settledCents >= invoicedCents ? 'paid' : 'partially_paid';
}

/** The payment states a receipt may move an order between. Anything else (a payment in flight, reconciled, failed, refunded) is left alone. */
const MOVABLE = ['unpaid', 'partially_paid', 'paid'] as const;

export interface PaymentMove {
  stage: 'payment_confirmed' | 'payment_partial' | 'payment_reversed';
  paymentStatus: SettledState;
}

/** The stage that takes an order from its current payment state to the settled one; null when nothing should change. */
export function planPaymentMove(current: string, target: SettledState): PaymentMove | null {
  if (!(MOVABLE as readonly string[]).includes(current) || current === target) return null;
  if (target === 'paid') return { stage: 'payment_confirmed', paymentStatus: 'paid' };
  if (current === 'unpaid') return { stage: 'payment_partial', paymentStatus: 'partially_paid' };
  return { stage: 'payment_reversed', paymentStatus: target };
}
