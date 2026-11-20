/** How an invoice stands, in the words staff read: its signing with KRA, what has been paid, what has been credited. Pure. */

export type SigningState = 'signed' | 'failed' | 'being_signed' | 'not_signed' | 'waiting' | 'unknown';

export const SIGNING_WORDS: Record<SigningState, { label: string; tone: 'green' | 'red' | 'amber' | 'gray' }> = {
  signed: { label: 'Signed with KRA', tone: 'green' },
  failed: { label: 'Signing failed', tone: 'red' },
  being_signed: { label: 'Being signed', tone: 'amber' },
  not_signed: { label: 'Not signed', tone: 'gray' },
  waiting: { label: 'Waiting to be signed', tone: 'amber' },
  unknown: { label: 'Not considered yet', tone: 'gray' },
};

/** The latest event of the signing log for the invoice: what kind it was (a decision, or the transmission) and its outcome. */
export function signingStateOf(latest: { eventType: string; outcome: string } | null): SigningState {
  if (latest === null) return 'unknown';
  const { eventType, outcome } = latest;
  if (outcome === 'fail') return 'failed';
  if (outcome === 'defer') return 'waiting';
  if (outcome === 'skip') return 'not_signed';
  if (outcome === 'sign') return eventType === 'transmission' ? 'signed' : 'being_signed';
  return 'unknown';
}

export type PaymentState = 'paid' | 'partly_paid' | 'unpaid' | 'credited';

/** The invoice's money: credited in full wins, then what the order's payment state says. */
export function paymentStateOf(total: number, credited: number, orderPaymentStatus: string | null): PaymentState {
  if (credited > 0 && credited + 0.005 >= total) return 'credited';
  if (orderPaymentStatus === 'paid' || orderPaymentStatus === 'reconciled') return 'paid';
  if (orderPaymentStatus === 'partially_paid') return 'partly_paid';
  return 'unpaid';
}

export const PAYMENT_WORDS: Record<PaymentState, { label: string; tone: 'green' | 'amber' | 'gray' | 'sky' }> = {
  paid: { label: 'Paid', tone: 'green' },
  partly_paid: { label: 'Partly paid', tone: 'amber' },
  unpaid: { label: 'Unpaid', tone: 'gray' },
  credited: { label: 'Credited', tone: 'sky' },
};

export const INVOICE_KIND_WORDS: Record<string, string> = { tax_invoice: 'Tax invoice', tax_invoice_part: 'Part invoice', proforma: 'Proforma invoice', delivery_invoice: 'Delivery invoice' };
export const INVOICE_KINDS = ['tax_invoice', 'proforma', 'delivery_invoice'] as const;
/** The kinds the invoice list can be narrowed to: the documents that can be made for an order, and the part invoices of an order invoiced in parts. */
export const LIST_KINDS = ['tax_invoice', 'tax_invoice_part', 'proforma', 'delivery_invoice'] as const;
export const isListKind = (value: unknown): value is (typeof LIST_KINDS)[number] => typeof value === 'string' && (LIST_KINDS as readonly string[]).includes(value);
export const isInvoiceKind = (value: unknown): value is (typeof INVOICE_KINDS)[number] => typeof value === 'string' && (INVOICE_KINDS as readonly string[]).includes(value);
