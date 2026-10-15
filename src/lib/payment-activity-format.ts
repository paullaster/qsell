import { words } from './payment-options';

/**
 * The words the payment activity and Bill Manager screens print for a row. Pure: the screens only
 * show what these return.
 */
export type ActivityRow = Record<string, string | number | boolean | null | undefined>;

const present = (value: string | number | boolean | null | undefined): boolean => value !== null && value !== undefined && value !== false && value !== '' && value !== 0;
const text = (value: string | number | boolean | null | undefined): string => (typeof value === 'string' || typeof value === 'number' ? String(value) : '');

export { words };

/** A time as the viewer's locale writes it, or nothing. */
export function when(iso: string | null | undefined): string {
  return iso === null || iso === undefined || iso === '' ? '' : new Date(iso).toLocaleString();
}

/** The detail line of a row from the activity lists: only the facts it has, each after a dot. */
export function rowDetail(r: ActivityRow, formatAmount: (amount: string) => string): string {
  const parts: [unknown, string][] = [
    [r.provider, ` · ${text(r.provider)}`],
    [r.method, ` · ${text(r.method)}`],
    [r.reference, ` · ${text(r.reference)}`],
    [r.platformReference, ` · ${text(r.platformReference)}`],
    [r.amount, ` · ${formatAmount(text(r.amount))}`],
    [r.shortcode, ` · to ${text(r.shortcode)}`],
    [r.accountReference, ` · account “${text(r.accountReference)}”`],
    [r.verifiedBy, ` · confirmed by ${words(text(r.verifiedBy))}`],
    [r.ip, ` · from ${text(r.ip)}`],
    [r.duplicate, ' · a repeat of an earlier one'],
    [r.attempts, ` · ${text(r.attempts)} attempt(s)`],
  ];
  return parts.filter(([value]) => present(value as string | number | boolean | null | undefined)).map(([, label]) => label).join('');
}

/** What kind of row it is, in words. */
export const rowTitle = (r: ActivityRow): string => words(text(r.operation ?? r.kind));

/** The state of a row: operations carry a status, callbacks and money a state. */
export const rowState = (r: ActivityRow): string => text(r.status ?? r.state);

/** The colour class of a count on the summary: red or amber when it needs a look. */
export function countTone(n: number, tone: 'red' | 'amber' | 'green'): string {
  if (n > 0 && tone === 'red') return 'text-red-700';
  if (n > 0 && tone === 'amber') return 'text-amber-700';
  return 'text-fg-strong';
}

export interface BillRequestRow {
  operation: string;
  count: number;
  reference: string | null;
}

/** "bill invoice · 3 invoices" or "bill cancel · INV-1". */
export function billRequestLabel(o: BillRequestRow): string {
  if (o.count > 1) return `${words(o.operation)} · ${String(o.count)} invoices`;
  return o.reference !== null && o.reference !== '' ? `${words(o.operation)} · ${o.reference}` : words(o.operation);
}

/** The first line of a long reason, cut short. */
export const shortReason = (reason: string | null | undefined, max: number): string => (reason === null || reason === undefined ? '' : reason.slice(0, max));
