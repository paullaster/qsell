/**
 * Exact money arithmetic for the ledgers. Amounts are held as scaled integers (four decimal
 * places) so sums never drift, and are only turned into text at the edges.
 */
export const SCALE = 4;
const FACTOR = 10n ** BigInt(SCALE);

/** An amount in 1/10,000ths of the currency unit. */
export type Scaled = bigint;

const PATTERN = /^-?\d+(\.\d+)?$/;

export class AmountError extends Error {}

/** "12.5" -> 125000n. More than four decimals is refused rather than silently rounded. */
export function parseAmount(value: string | number): Scaled {
  const text = typeof value === 'number' ? numberToText(value) : value.trim();
  if (!PATTERN.test(text)) throw new AmountError(`"${String(value)}" is not an amount`);
  const negative = text.startsWith('-');
  const [whole = '0', frac = ''] = text.replace('-', '').split('.');
  if (frac.length > SCALE) {
    if (/[1-9]/.test(frac.slice(SCALE))) {
      throw new AmountError(`"${text}" has more than ${SCALE} decimal places`);
    }
  }
  const padded = (frac + '0'.repeat(SCALE)).slice(0, SCALE);
  const result = BigInt(whole) * FACTOR + BigInt(padded);
  return negative ? -result : result;
}

function numberToText(n: number): string {
  if (!Number.isFinite(n)) throw new AmountError('amount is not a finite number');
  // toFixed avoids exponent notation; 6 places then rounding guards float noise.
  return n.toFixed(SCALE + 2).replace(/0{1,2}$/, '');
}

/** 125000n -> "12.5000" (always four places, as stored in numeric(20,4)). */
export function formatAmount(value: Scaled): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / FACTOR;
  const frac = (abs % FACTOR).toString().padStart(SCALE, '0');
  return `${negative ? '-' : ''}${whole.toString()}.${frac}`;
}

/** Display form with the currency's own number of decimals (rounded half-even). */
export function formatForDisplay(value: Scaled, decimals: number): string {
  const [whole = '0', frac = ''] = formatAmount(roundTo(value, decimals)).split('.');
  return decimals <= 0 ? whole : `${whole}.${frac.slice(0, Math.min(decimals, SCALE))}`;
}

/** Round half to even at `decimals` places (0..4). */
export function roundTo(value: Scaled, decimals: number): Scaled {
  if (decimals >= SCALE) return value;
  const unit = 10n ** BigInt(SCALE - decimals);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const q = abs / unit;
  const r = abs % unit;
  const half = unit / 2n;
  let rounded = q;
  if (r > half || (r === half && q % 2n === 1n)) rounded = q + 1n;
  const result = rounded * unit;
  return negative ? -result : result;
}

/**
 * Multiply an amount by a rate held as text ("129.5", up to 8 decimals), rounding half-even to
 * four places. Used to get the base-currency amount of a foreign-currency line.
 */
export function convert(value: Scaled, rate: string): Scaled {
  if (!PATTERN.test(rate)) throw new AmountError(`"${rate}" is not a rate`);
  const [whole = '0', frac = ''] = rate.split('.');
  const places = Math.min(frac.length, 8);
  const mantissa = BigInt(whole + frac.slice(0, places).padEnd(places, '0'));
  const divisor = 10n ** BigInt(places);
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const product = abs * mantissa;
  let q = product / divisor;
  const r = product % divisor;
  // Rounds the remainder against half the divisor; doubling avoids the odd-divisor and the
  // divisor-of-one cases, where half would be zero and an exact result would round up.
  const twice = r * 2n;
  if (twice > divisor || (twice === divisor && q % 2n === 1n)) q += 1n;
  return negative ? -q : q;
}

export const ZERO: Scaled = 0n;
export const isZero = (v: Scaled) => v === 0n;
export const abs = (v: Scaled) => (v < 0n ? -v : v);
