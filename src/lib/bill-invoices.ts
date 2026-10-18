/**
 * How Bill Manager invoices are shown: the words and colours for each state, and how much is still to pay. Pure.
 */
export type BillStatus = 'requested' | 'sent' | 'failed' | 'part_paid' | 'paid' | 'cancelled';

export const BILL_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  requested: { label: 'Being sent', tone: 'amber' },
  sent: { label: 'Sent, not paid', tone: 'sky' },
  part_paid: { label: 'Part paid', tone: 'amber' },
  paid: { label: 'Paid', tone: 'green' },
  failed: { label: 'Refused', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export const billStatus = (status: string): { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' } => (Object.hasOwn(BILL_STATUS, status) ? BILL_STATUS[status] : { label: status, tone: 'gray' });

const toCents = (s: string): number => Math.round(Number(s) * 100);

/** What is still to be paid on an invoice, as text with two places. */
export const stillDue = (amount: string, paid: string): string => (Math.max(0, toCents(amount) - toCents(paid)) / 100).toFixed(2);

/** True when an invoice has gone past its due date without being paid or cancelled. */
export const isOverdue = (i: { status: string; dueDate: string }, today: string): boolean => (i.status === 'sent' || i.status === 'part_paid') && i.dueDate < today;

/** The one line under an invoice that says what is wrong with it, if anything. */
export function invoiceNote(i: { status: string; failureReason: string | null; ackError: string | null; acknowledged: boolean }): string | null {
  if (i.status === 'failed') return i.failureReason ?? 'Bill Manager did not accept it.';
  if ((i.status === 'paid' || i.status === 'part_paid') && i.ackError !== null) return `Paid, but Bill Manager was not told: ${i.ackError}`;
  if (i.status === 'paid' && !i.acknowledged) return 'Paid. Bill Manager has not yet been told, so the customer may not have a receipt.';
  return null;
}
