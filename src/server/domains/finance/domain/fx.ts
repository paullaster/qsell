import { AmountError, convert, parseAmount, type Scaled } from './amount';

/**
 * Foreign-currency arithmetic: which rate applies on a day, what an amount is worth in the books' currency, and how much a
 * customer paying at a different rate than the invoice gained or lost the business. Exact (scaled integers), pure.
 *
 * A rate is written as "base units per one unit of the foreign currency": 129.50 means one US dollar is 129.50 shillings.
 */
export interface DatedRate {
  effectiveOn: string;
  rate: string;
}

/** The rate in force on a date: the newest one that started on or before it. Null when none had started yet. */
export function pickRate(rates: readonly DatedRate[], date: string): string | null {
  let best: DatedRate | null = null;
  for (const r of rates) if (r.effectiveOn <= date && (best === null || r.effectiveOn > best.effectiveOn)) best = r;
  return best === null ? null : best.rate;
}

/** What is wrong with a rate as typed, or null. Up to 8 decimals, above zero, and not absurd. */
export function checkRate(rate: string): string | null {
  const text = rate.trim();
  if (!/^\d+(\.\d{1,8})?$/.test(text)) return 'A rate is a positive number with at most 8 decimals, such as 129.5.';
  const n = Number(text);
  if (!(n >= 0.00000001)) return 'A rate must be above zero.';
  if (n > 1_000_000_000) return 'That rate is too large to be right. Check it.';
  return null;
}

/** An amount in the foreign currency, in the books' currency at the rate; four decimals, half-even, as the ledgers hold it. */
export function baseValue(amount: string, rate: string): Scaled {
  return convert(parseAmount(amount), rate);
}

/**
 * A customer owed `amount` (booked at the invoice's rate) paid it (booked at the receipt's rate): what the business gained when
 * positive, lost when negative, in the books' currency.
 */
export function settlementDifference(amount: string, receiptRate: string, invoiceRate: string): Scaled {
  return baseValue(amount, receiptRate) - baseValue(amount, invoiceRate);
}

/**
 * An open balance carried at one rate and worth another: the change in the value of the asset. A debit balance (positive) worth
 * more is a gain; a credit balance (negative, owed to the customer) worth more is a loss, which the sign gives for free.
 */
export function revaluationDifference(remaining: string, carryingRate: string, newRate: string): Scaled {
  return baseValue(remaining, newRate) - baseValue(remaining, carryingRate);
}

/** Four-decimal scaled amount to whole cents, rounded half away from zero, for sums shown to people. */
export function toCentsRounded(v: Scaled): number {
  const negative = v < 0n;
  const abs = negative ? -v : v;
  const cents = Number((abs + 50n) / 100n);
  return negative ? -cents : cents;
}

export { AmountError };
