import { has } from '@/lib/values';

/** Counting the cash in a drawer: notes and coins turned into a total, the difference in words, and what a count needs. Money in whole cents. Pure. */

type Checked<T> = { ok: true; value: T } | { ok: false; error: string };

export interface DenominationInput {
  /** The value of one note or coin, as typed (for example "1000" or "0.50"). */
  value: string;
  /** How many were counted, as typed. */
  count: string;
}

export interface Denomination {
  value: string;
  count: number;
}

export const MAX_DENOMINATIONS = 30;
const MAX_COUNT = 1_000_000;

const centsOf = (text: string): number | null => {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d{1,9}(\.\d{1,2})?$/.test(t)) return null;
  return Math.round(Number(t) * 100);
};

/** Rows the person left empty are ignored; the others are checked and added up. */
export function totalOfCount(
  rows: readonly DenominationInput[],
): Checked<{ cents: number; rows: Denomination[] }> {
  const filled = rows.filter((r) => r.value.trim() !== '' || r.count.trim() !== '');
  if (filled.length > MAX_DENOMINATIONS)
    return {
      ok: false,
      error: `Count at most ${String(MAX_DENOMINATIONS)} kinds of note and coin.`,
    };
  const seen = new Set<number>();
  const out: Denomination[] = [];
  let cents = 0;
  for (const [i, r] of filled.entries()) {
    const label = `Row ${String(i + 1)}`;
    const value = centsOf(r.value);
    if (value === null || value <= 0)
      return {
        ok: false,
        error: `${label}: the value of one note or coin must be more than zero, with at most 2 decimals.`,
      };
    if (seen.has(value))
      return {
        ok: false,
        error: `${label}: that value is already counted in another row. Add the numbers together.`,
      };
    seen.add(value);
    const t = r.count.trim();
    if (!/^\d{1,7}$/.test(t) || Number(t) > MAX_COUNT)
      return {
        ok: false,
        error: `${label}: how many were counted must be a whole number, 0 or more.`,
      };
    const count = Number(t);
    out.push({ value: (value / 100).toFixed(2), count });
    cents += value * count;
  }
  return { ok: true, value: { cents, rows: out } };
}

const words = (c: number) =>
  (Math.abs(c) / 100).toLocaleString('en-KE', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

/** Counted less expected, in a few words. */
export function differenceWords(differenceCents: number): string {
  if (differenceCents === 0) return 'The cash agrees with the books.';
  return differenceCents < 0
    ? `Short by ${words(differenceCents)}.`
    : `Over by ${words(differenceCents)}.`;
}

export const MIN_NOTE = 5;

/** What must be said when the count does not agree with the books; null when nothing is missing. */
export function countProblem(
  differenceCents: number,
  note: string,
  hasVarianceAccount: boolean,
): string | null {
  if (differenceCents === 0) return null;
  if (!hasVarianceAccount) return 'Choose the account the difference is written to.';
  if (note.trim().length < MIN_NOTE)
    return `Say why the cash does not agree with the books (at least ${String(MIN_NOTE)} characters).`;
  return null;
}

/** The total typed straight in, when notes and coins are not counted one by one. */
export function totalTyped(text: string): Checked<number> {
  const c = centsOf(text);
  return c === null
    ? { ok: false, error: 'The total must be an amount with at most 2 decimals.' }
    : { ok: true, value: c };
}

export const hasNote = (note: string | null | undefined): boolean => has((note ?? '').trim());

/** What was counted in cents, whichever way it was entered: row by row or as a typed total. */
export function countedCents(
  byKind: boolean,
  rows: readonly DenominationInput[],
  total: string,
): Checked<number> {
  if (!byKind) return totalTyped(total);
  const c = totalOfCount(rows);
  return c.ok ? { ok: true, value: c.value.cents } : c;
}
