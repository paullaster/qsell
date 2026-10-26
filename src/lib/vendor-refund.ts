/** Pure rules for money a vendor pays back (an overpayment, a payment on account, an advance or a credit memo not used against an invoice). */
import { isDay } from './vendor-insights';

export const REFUND_STATUS: Record<'pending' | 'posted' | 'cancelled' | 'reversed', { label: string; tone: 'amber' | 'green' | 'gray' | 'red' }> = {
  pending: { label: 'Waiting to be booked', tone: 'amber' },
  posted: { label: 'Booked', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
  reversed: { label: 'Reversed', tone: 'red' },
};

export interface RefundRequestForm {
  creditEntryId: string;
  methodId: string;
  /** Empty means all that is still open on the credit. */
  amount: string;
  note: string;
}

export interface RefundReceipt {
  reference: string;
  receivedOn: string;
}

const AMOUNT = /^\d{1,12}(\.\d{1,2})?$/;

/** Cents from an amount text, or null when it is not a positive amount. */
export function refundCents(text: string): number | null {
  const t = text.trim();
  if (!AMOUNT.test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  const cents = Number(whole) * 100 + Number(frac.padEnd(2, '0'));
  return cents > 0 ? cents : null;
}

export function checkRefundRequest(f: RefundRequestForm, openCents: number): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.creditEntryId === '') p.creditEntryId = 'Choose the payment or credit being refunded.';
  if (f.methodId === '') p.methodId = 'Choose how the money came in.';
  if (f.amount.trim() !== '') {
    const cents = refundCents(f.amount);
    if (cents === null) p.amount = 'Enter the amount refunded, above zero.';
    else if (cents > openCents) p.amount = `Only ${(openCents / 100).toFixed(2)} is open on that credit.`;
  }
  if (f.note.length > 400) p.note = 'Keep the note to 400 characters.';
  return p;
}

export function checkRefundReceipt(r: RefundReceipt, today: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (r.reference.trim() === '') p.reference = 'Enter the reference of the transfer or receipt the money came in on.';
  if (!isDay(r.receivedOn)) p.receivedOn = 'Enter the date the money arrived.';
  else if (r.receivedOn > today) p.receivedOn = 'The date cannot be in the future.';
  return p;
}
