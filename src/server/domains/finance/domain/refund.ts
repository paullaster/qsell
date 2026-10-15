
import { has } from '@/lib/values';
/** Refund rules that need no database. Money is in whole cents. */

export type RefundStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'rejected' | 'cancelled';

const NEXT: Record<RefundStatus, RefundStatus[]> = {
  draft: ['pending_approval', 'approved', 'cancelled'],
  pending_approval: ['approved', 'rejected', 'cancelled'],
  approved: ['paid', 'cancelled'],
  // A rejected refund is reopened (back to draft), never revived by editing history.
  rejected: ['draft'],
  paid: [],
  cancelled: [],
};

export function canMove(from: RefundStatus, to: RefundStatus): boolean {
  return NEXT[from].includes(to);
}

/** Paid, rejected-and-closed and cancelled refunds are finished: nothing edits them again. */
export const isFinished = (s: RefundStatus) => s === 'paid' || s === 'cancelled';

/** The last nine digits: enough to tell two phone numbers apart whatever way they were typed. */
export function phoneKey(raw: string | null | undefined): string {
  const digits = (raw ?? '').replace(/\D/g, '');
  return digits.slice(-9);
}

type Details = Record<string, string | undefined>;

const REQUIRED: Record<string, { keys: string[]; labels: string[] }> = {
  mobile_money: { keys: ['phone'], labels: ['the phone number to pay'] },
  bank_transfer: { keys: ['bankName', 'accountNumber', 'accountName'], labels: ['the bank', 'the account number', 'the account name'] },
  bank_deposit: { keys: ['bankName', 'accountNumber', 'accountName'], labels: ['the bank', 'the account number', 'the account name'] },
  gateway: { keys: ['bankName', 'accountNumber', 'accountName'], labels: ['the bank', 'the account number', 'the account name'] },
  cheque: { keys: ['payeeName'], labels: ['who the cheque is made out to'] },
  cash: { keys: ['recipientName'], labels: ['who will collect the cash'] },
};

/** What must be known to pay this way. Returns the problem in words, or null. */
export function checkPayoutDetails(kind: string, d: Details): string | null {
  const need = REQUIRED[kind] ?? { keys: ['recipientName'], labels: ['who is being paid'] };
  const missing = need.keys.map((k, i) => (has((d[k] ?? '').trim()) ? null : need.labels[i])).filter((x): x is string => x !== null);
  if (missing.length > 0) return `Enter ${missing.join(', ')}.`;
  if (kind === 'mobile_money' && phoneKey(d.phone).length < 9) return 'The phone number looks too short.';
  return null;
}

/**
 * Is the money going somewhere other than what we have on record for the customer? Paying a
 * different phone than the customer's own is the classic refund fraud, so it is flagged, needs its
 * own permission, and goes for approval whatever the amount.
 */
export function destinationChanged(kind: string, d: Details, customerPhone: string | null | undefined): boolean {
  if (kind === 'mobile_money') {
    const given = phoneKey(d.phone);
    const known = phoneKey(customerPhone);
    return given !== '' && given !== known;
  }
  return false;
}

/** What can still be asked for: the obligation, less refunds already asked for and not yet taken from it. */
export function availableToRefund(obligationOpenCents: number, committedCents: number): number {
  return Math.max(0, obligationOpenCents - committedCents);
}

export interface RefundLike {
  customerId: string;
  amountCents: number;
  methodId: string;
  status: RefundStatus;
  createdAt: Date;
}

/** The same customer, amount and method asked for again within a day, while the first still stands. */
export function looksDuplicate(existing: RefundLike[], candidate: { customerId: string; amountCents: number; methodId: string }, now: Date, windowHours = 24): RefundLike | null {
  const cutoff = now.getTime() - windowHours * 3600_000;
  return (
    existing.find(
      (r) =>
        r.customerId === candidate.customerId &&
        r.amountCents === candidate.amountCents &&
        r.methodId === candidate.methodId &&
        r.status !== 'cancelled' &&
        r.status !== 'rejected' &&
        r.createdAt.getTime() >= cutoff,
    ) ?? null
  );
}

/** An order is "refunded" only when paid refunds against it add up to everything it was paid. */
export function refundedState(paidCents: number, refundedCents: number): 'refunded' | 'partially_refunded' | 'none' {
  if (refundedCents <= 0) return 'none';
  return paidCents > 0 && refundedCents >= paidCents ? 'refunded' : 'partially_refunded';
}
