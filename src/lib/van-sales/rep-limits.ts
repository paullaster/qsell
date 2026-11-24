/**
 * What a rep may do on their own (docs/architecture/van-sales.md §4.1): each check says no in words, or null for yes. The server holds
 * every one of these; the phone shows the same words early.
 */
export interface RepLimits {
  maxDiscountPercent: number;
  maxCreditPerDay: number;
  mayOverridePrice: boolean;
  maySellOnCredit: boolean;
}

export const NO_LIMITS: RepLimits = { maxDiscountPercent: 0, maxCreditPerDay: 0, mayOverridePrice: false, maySellOnCredit: false };

const kes = (n: number): string => `KES ${(Math.round(n * 100) / 100).toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function discountProblem(limits: Pick<RepLimits, 'maxDiscountPercent'>, percent: number): string | null {
  if (!Number.isFinite(percent) || percent < 0) return 'A discount cannot be less than nothing.';
  if (percent === 0) return null;
  if (limits.maxDiscountPercent <= 0) return 'You are not allowed to give a discount.';
  return percent > limits.maxDiscountPercent ? `You may give at most ${String(limits.maxDiscountPercent)}% off.` : null;
}

export function creditProblem(limits: Pick<RepLimits, 'maySellOnCredit' | 'maxCreditPerDay'>, amount: number, givenToday: number): string | null {
  if (!limits.maySellOnCredit) return 'You are not allowed to sell on credit.';
  const left = limits.maxCreditPerDay - givenToday;
  if (limits.maxCreditPerDay > 0 && amount > left) return left <= 0 ? `You have given all the credit you may today (${kes(limits.maxCreditPerDay)}).` : `You may give ${kes(left)} more credit today.`;
  return null;
}

export const priceProblem = (limits: Pick<RepLimits, 'mayOverridePrice'>): string | null => (limits.mayOverridePrice ? null : 'You are not allowed to change a price.');

/** Reads the limits a manager typed, refusing nonsense in words. */
export function readLimits(raw: unknown): { ok: true; limits: RepLimits } | { ok: false; error: string } {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const pct = r.maxDiscountPercent;
  const credit = r.maxCreditPerDay;
  if (typeof pct !== 'number' || !Number.isFinite(pct) || pct < 0 || pct > 100) return { ok: false, error: 'The most discount a rep may give is a percent from 0 to 100.' };
  if (typeof credit !== 'number' || !Number.isFinite(credit) || credit < 0 || credit > 1_000_000_000) return { ok: false, error: 'The most credit a rep may give in a day is an amount from 0 up (0 means no limit).' };
  if (typeof r.mayOverridePrice !== 'boolean' || typeof r.maySellOnCredit !== 'boolean') return { ok: false, error: 'Say whether the rep may change prices and sell on credit.' };
  return { ok: true, limits: { maxDiscountPercent: pct, maxCreditPerDay: Math.round(credit * 100) / 100, mayOverridePrice: r.mayOverridePrice, maySellOnCredit: r.maySellOnCredit } };
}
