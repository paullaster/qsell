import type { ResetPolicy } from './types';

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * The counter a document is numbered from. It adds the branch when the pattern itself contains
 * {BRANCH}: the branch is part of the number, so each branch needs its own unbroken sequence
 * (and its own lock, which is also what lets 200 branches number invoices in parallel).
 */
export function counterKey(
  reset: ResetPolicy,
  date: string,
  perBranch: boolean,
  branchCode: string | null,
): string {
  const period = periodKey(reset, date);
  if (!perBranch) return period;
  const branch = (branchCode ?? '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return period ? `${period}|${branch}` : `|${branch}`;
}

/** The counter a document falls into: one per year or month when the series restarts. */
export function periodKey(reset: ResetPolicy, date: string): string {
  if (reset === 'never') return '';
  return reset === 'yearly' ? date.slice(0, 4) : date.slice(0, 7);
}
