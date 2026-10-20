/**
 * Exact decimal arithmetic for quantities and conversion factors, on whole numbers scaled by 10^10
 * (the scale of the database columns). Floating point is never used: 0.1 + 0.2 and 1/3 must not
 * leak into stock counts. Everything here is pure.
 */
export const DECIMAL_SCALE = 10;
const ONE = 10n ** BigInt(DECIMAL_SCALE);

/** A decimal written with up to 14 whole and 10 fractional digits, as a scaled whole number; null when it is not one. */
export function parseDecimal(text: string): bigint | null {
  const m = /^(-?)(\d{1,14})(?:\.(\d{1,10}))?$/.exec(text.trim());
  if (m === null) return null;
  const sign = m[1] === '-' ? -1n : 1n;
  const whole = BigInt(m[2] ?? '0') * ONE;
  const fraction = BigInt((m[3] ?? '').padEnd(DECIMAL_SCALE, '0'));
  return sign * (whole + fraction);
}

/** The scaled number written out with exactly `places` fractional digits (rounded half away from zero). */
export function formatDecimal(value: bigint, places = DECIMAL_SCALE): string {
  const unit = 10n ** BigInt(DECIMAL_SCALE - places);
  const rounded = divideRounded(value, unit);
  const negative = rounded < 0n;
  const digits = (negative ? -rounded : rounded).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places);
  return `${negative ? '-' : ''}${whole}${places === 0 ? '' : `.${fraction}`}`;
}

/** a / b as a whole number, halves rounded away from zero. */
export function divideRounded(a: bigint, b: bigint): bigint {
  const negative = a < 0n !== b < 0n;
  const absA = a < 0n ? -a : a;
  const absB = b < 0n ? -b : b;
  const quotient = (absA * 2n + absB) / (absB * 2n);
  return negative ? -quotient : quotient;
}

/** True when the text is a decimal that has no more fractional digits than `places`. */
export function fitsPlaces(text: string, places: number): boolean {
  const value = parseDecimal(text);
  if (value === null) return false;
  return value % 10n ** BigInt(DECIMAL_SCALE - places) === 0n;
}

/** A quantity rounded to the three decimals stored (halves away from zero), so adding in JS never leaves 0.30000000000000004. */
export const roundQty = (value: number): number => {
  const scaled = Math.abs(value) * 1000 + 1e-9;
  return Math.sign(value) * (Math.round(scaled) / 1000);
};

/** True when a quantity has no more fractional digits than a unit allows (0 to 3). */
export const quantityFits = (value: number, decimals: number): boolean => {
  if (!Number.isFinite(value)) return false;
  const factor = 10 ** decimals;
  return Math.abs(value * factor - Math.round(value * factor)) < 1e-6;
};
