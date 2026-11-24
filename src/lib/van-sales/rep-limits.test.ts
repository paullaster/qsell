import { describe, expect, it } from 'vitest';
import { NO_LIMITS, creditProblem, discountProblem, priceProblem, readLimits } from './rep-limits';

const limits = { maxDiscountPercent: 5, maxCreditPerDay: 20_000, mayOverridePrice: true, maySellOnCredit: true };

describe('a rep\'s limits', () => {
  it('allows a discount up to the limit and says no past it or when none is allowed', () => {
    expect(discountProblem(limits, 0)).toBeNull();
    expect(discountProblem(limits, 5)).toBeNull();
    expect(discountProblem(limits, 5.1)).toBe('You may give at most 5% off.');
    expect(discountProblem(NO_LIMITS, 1)).toBe('You are not allowed to give a discount.');
    expect(discountProblem(NO_LIMITS, 0)).toBeNull();
    expect(discountProblem(limits, -1)).toContain('less than nothing');
    expect(discountProblem(limits, Number.NaN)).toContain('less than nothing');
  });
  it('allows credit within the day\'s limit and says how much is left', () => {
    expect(creditProblem(limits, 5000, 0)).toBeNull();
    expect(creditProblem(limits, 5000, 15_000)).toBeNull();
    expect(creditProblem(limits, 5000.01, 15_000)).toBe('You may give KES 5,000.00 more credit today.');
    expect(creditProblem(limits, 1, 20_000)).toBe('You have given all the credit you may today (KES 20,000.00).');
    expect(creditProblem(NO_LIMITS, 1, 0)).toBe('You are not allowed to sell on credit.');
    expect(creditProblem({ maySellOnCredit: true, maxCreditPerDay: 0 }, 1_000_000, 5_000_000)).toBeNull();
  });
  it('allows a changed price only when permitted', () => {
    expect(priceProblem(limits)).toBeNull();
    expect(priceProblem(NO_LIMITS)).toBe('You are not allowed to change a price.');
  });
  it('are read from what a manager typed, refusing nonsense', () => {
    expect(readLimits(limits)).toEqual({ ok: true, limits });
    expect(readLimits({ ...limits, maxDiscountPercent: 101 }).ok).toBe(false);
    expect(readLimits({ ...limits, maxDiscountPercent: -1 }).ok).toBe(false);
    expect(readLimits({ ...limits, maxCreditPerDay: 'lots' }).ok).toBe(false);
    expect(readLimits({ ...limits, mayOverridePrice: 'yes' }).ok).toBe(false);
    expect(readLimits(null).ok).toBe(false);
  });
});
