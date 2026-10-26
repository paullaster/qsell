/** Foreign currency on the payables side: what an amount is worth in the books' currency, and what paying at another rate gained or lost. Exact, pure. */

const RATE_SCALE = 8;
const TEN = 10n ** BigInt(RATE_SCALE);

/** A rate text with up to 8 decimals as a scaled integer, or null when it is not a positive rate. */
export function scaledRate(rate: string): bigint | null {
  const t = rate.trim();
  if (!/^\d{1,15}(\.\d{1,8})?$/.test(t)) return null;
  const [whole = '0', frac = ''] = t.split('.');
  const v = BigInt(whole) * TEN + BigInt(frac.padEnd(RATE_SCALE, '0'));
  return v > 0n ? v : null;
}

/** An amount in cents of a foreign currency, in cents of the books' currency at the rate, rounded half away from zero. */
export function baseCents(cents: number, rate: string): number {
  const r = scaledRate(rate);
  if (r === null) throw new Error(`"${rate}" is not an exchange rate`);
  const product = BigInt(Math.abs(cents)) * r;
  const q = product / TEN;
  const rem = product % TEN;
  const rounded = rem * 2n >= TEN ? q + 1n : q;
  return cents < 0 ? -Number(rounded) : Number(rounded);
}

/**
 * Paying `clearedCents` of an invoice carried at `invoiceRate` with money valued at `paymentRate`: positive when the business gained
 * (the liability was booked at more than it cost to settle), negative when it lost, in cents of the books' currency.
 */
export function settlementGain(clearedCents: number, invoiceRate: string, paymentRate: string): number {
  return baseCents(clearedCents, invoiceRate) - baseCents(clearedCents, paymentRate);
}

/** Whether a currency code is one the books can take: three capital letters. */
export const isCurrencyCode = (code: string): boolean => /^[A-Z]{3}$/.test(code);
