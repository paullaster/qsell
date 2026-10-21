import { has } from '@/lib/values';
import { phoneKey } from './refund';

/** Refund velocity rules that need no database. Money is in whole cents. */

export type VelocityMode = 'review' | 'refuse';

export interface RefundLimitValues {
  enabled: boolean;
  windowHours: number;
  maxPerCustomer: number | null;
  maxCentsPerCustomer: number | null;
  maxPerDestination: number | null;
  maxPerRequester: number | null;
  maxCentsPerRequester: number | null;
  mode: VelocityMode;
}

export const NO_LIMITS: RefundLimitValues = {
  enabled: false,
  windowHours: 24,
  maxPerCustomer: null,
  maxCentsPerCustomer: null,
  maxPerDestination: null,
  maxPerRequester: null,
  maxCentsPerRequester: null,
  mode: 'review',
};

/** What already happened in the window, before the refund being asked for. */
export interface VelocityUsage {
  customer: { count: number; cents: number };
  /** Null when the way of paying has no destination to count (cash, cheque). */
  destination: { count: number } | null;
  requester: { count: number; cents: number };
}

const money = (cents: number) =>
  (cents / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const plural = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

function hours(h: number): string {
  if (h % 24 === 0) return h === 24 ? 'a day' : `${String(h / 24)} days`;
  return h === 1 ? 'an hour' : `${String(h)} hours`;
}

/** The limits this refund would go past, each in a sentence for the person. Empty when none, or when limits are off. */
export function checkVelocity(
  limits: RefundLimitValues,
  usage: VelocityUsage,
  candidateCents: number,
): string[] {
  if (!limits.enabled) return [];
  const within = hours(limits.windowHours);
  const out: string[] = [];
  if (limits.maxPerCustomer !== null && usage.customer.count + 1 > limits.maxPerCustomer) {
    out.push(
      `This customer would have ${plural(usage.customer.count + 1, 'refund', 'refunds')} in ${within}; the limit is ${String(limits.maxPerCustomer)}.`,
    );
  }
  if (
    limits.maxCentsPerCustomer !== null &&
    usage.customer.cents + candidateCents > limits.maxCentsPerCustomer
  ) {
    out.push(
      `This customer would be refunded ${money(usage.customer.cents + candidateCents)} in ${within}; the limit is ${money(limits.maxCentsPerCustomer)}.`,
    );
  }
  if (
    limits.maxPerDestination !== null &&
    usage.destination !== null &&
    usage.destination.count + 1 > limits.maxPerDestination
  ) {
    out.push(
      `This phone number or account would be paid ${plural(usage.destination.count + 1, 'refund', 'refunds')} in ${within}; the limit is ${String(limits.maxPerDestination)}.`,
    );
  }
  if (limits.maxPerRequester !== null && usage.requester.count + 1 > limits.maxPerRequester) {
    out.push(
      `You would have asked for ${plural(usage.requester.count + 1, 'refund', 'refunds')} in ${within}; the limit is ${String(limits.maxPerRequester)}.`,
    );
  }
  if (
    limits.maxCentsPerRequester !== null &&
    usage.requester.cents + candidateCents > limits.maxCentsPerRequester
  ) {
    out.push(
      `You would have asked for ${money(usage.requester.cents + candidateCents)} of refunds in ${within}; the limit is ${money(limits.maxCentsPerRequester)}.`,
    );
  }
  return out;
}

/** Where the money goes, as something comparable: a phone's last nine digits, or a bank account number. Null when there is none. */
export function destinationOf(
  kind: string,
  details: Record<string, string | undefined>,
): { field: 'phone' | 'accountNumber'; value: string } | null {
  if (kind === 'mobile_money') {
    const key = phoneKey(details.phone);
    return key.length >= 9 ? { field: 'phone', value: key } : null;
  }
  const account = (details.accountNumber ?? '').replace(/\s/g, '');
  if ((kind === 'bank_transfer' || kind === 'bank_deposit' || kind === 'gateway') && has(account))
    return { field: 'accountNumber', value: account };
  return null;
}
