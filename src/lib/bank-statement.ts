/**
 * The bank statement screens: the words for line states and kinds of entry, and the arithmetic of
 * reconciling a statement. Pure. Money is handled in whole cents.
 */
import type { StatusInfo } from './finance-statuses';

export const LINE_STATUS: Record<string, StatusInfo> = {
  unmatched: { label: 'Not matched', tone: 'amber' },
  proposed: { label: 'Suggested', tone: 'sky' },
  matched: { label: 'Matched', tone: 'green' },
  ignored: { label: 'Set aside', tone: 'gray' },
};

export const ENTRY_TYPE: Record<string, string> = {
  customer_receipt: 'Receipt',
  customer_receipt_reversal: 'Receipt reversed',
  refund: 'Refund',
  bank_charge: 'Bank charge',
  cheque_clearing: 'Cheque cleared',
  cash_sale: 'Cash sale',
  payment: 'Payment',
};

export const entryType = (type: string): string => (Object.hasOwn(ENTRY_TYPE, type) ? ENTRY_TYPE[type] : type);

/** "customer_receipt:amount_ref" -> "customer receipt amount ref". */
export const ruleWords = (rule: string): string => rule.replace(/[:_]/g, ' ');

export const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

export const toCents = (v: string): number => Math.round(Number(v) * 100);
export const fromCents = (c: number): string => (c / 100).toFixed(2);

export interface Counts {
  unmatched: number;
  proposed: number;
  matched: number;
  ignored: number;
}

export const toDealWith = (c: Pick<Counts, 'unmatched' | 'proposed'>): number => c.unmatched + c.proposed;

/** True for a line the bank paid out. */
export const isOutgoing = (amount: string): boolean => Number(amount) < 0;

export const canMatchTotal = (pickedCents: number, lineAmount: string): boolean => pickedCents > 0 && pickedCents === toCents(lineAmount);

export function pickedCents(entries: readonly { id: number; amount: string }[], picked: readonly number[]): number {
  return entries.filter((e) => picked.includes(e.id)).reduce((n, e) => n + toCents(e.amount), 0);
}

export interface PreviewLike {
  needsOpening: boolean;
  previous: { balance: string } | null;
  linesTotal: string;
  blockingCount: number;
  lineCount: number;
  bookBalance: string;
  outstandingNet: string;
}

export interface Reconciliation {
  openingCents: number | null;
  expectedCents: number | null;
  diffCents: number | null;
  canPost: boolean;
}

/** The bank's closing balance against the opening balance plus every line dealt with, to the cent. */
export function reconcile(preview: PreviewLike, opening: string, closing: string, mayPost: boolean): Reconciliation {
  const typedOpening = opening === '' ? null : toCents(opening);
  const openingCents = preview.needsOpening ? typedOpening : toCents(preview.previous?.balance ?? '0');
  const expectedCents = openingCents === null ? null : openingCents + toCents(preview.linesTotal);
  const diffCents = expectedCents === null || closing === '' ? null : toCents(closing) - expectedCents;
  return { openingCents, expectedCents, diffCents, canPost: mayPost && preview.blockingCount === 0 && preview.lineCount > 0 && diffCents === 0 };
}

/** Our books minus what the bank has not yet shown. */
export const booksNotYetSeen = (preview: Pick<PreviewLike, 'bookBalance' | 'outstandingNet'>): string => fromCents(toCents(preview.bookBalance) - toCents(preview.outstandingNet));

export const isDate = (text: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(text);

export const twoPlaces = (v: string | null): string => (v === null || v === '' ? '' : Number(v).toFixed(2));

/** What the list says when it has nothing to show. */
export function emptyLinesText(filter: 'open' | 'matched' | 'ignored', importedFiles: number): string {
  if (filter !== 'open') return 'Nothing here.';
  return importedFiles === 0 ? 'No statement has been imported for this account yet.' : 'Every imported line has been dealt with.';
}
