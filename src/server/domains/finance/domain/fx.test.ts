import { describe, expect, it } from 'vitest';
import { baseValue, checkRate, displayRate, pickRate, revaluationDifference, settlementDifference, toCentsRounded } from './fx';

describe('the rate on a day', () => {
  const rates = [{ effectiveOn: '2026-10-01', rate: '129.0000' }, { effectiveOn: '2026-10-10', rate: '130.5' }, { effectiveOn: '2026-10-20', rate: '131' }];
  it('is the newest that had started, and none before the first', () => {
    expect(pickRate(rates, '2026-09-30')).toBeNull();
    expect(pickRate(rates, '2026-10-01')).toBe('129.0000');
    expect(pickRate(rates, '2026-10-15')).toBe('130.5');
    expect(pickRate(rates, '2026-12-31')).toBe('131');
    expect(pickRate([], '2026-10-15')).toBeNull();
  });

  it('is checked as typed', () => {
    expect(checkRate('129.5')).toBeNull();
    expect(checkRate('0.00000001')).toBeNull();
    expect(checkRate('129,5')).toContain('positive number');
    expect(checkRate('-1')).toContain('positive number');
    expect(checkRate('1.123456789')).toContain('8 decimals');
    expect(checkRate('0')).toContain('above zero');
    expect(checkRate('0.000000001')).toContain('8 decimals');
    expect(checkRate('2000000000')).toContain('too large');
  });
});

describe('what money in another currency is worth', () => {
  it('converts exactly, four decimals, half-even', () => {
    expect(baseValue('100.00', '129.5')).toBe(129_500_000n);
    expect(baseValue('0.01', '129.5')).toBe(12_950n);
    expect(baseValue('1.00', '0.33333333')).toBe(3_333n);
  });

  it('is a gain when the customer paid at a stronger rate than the invoice, and a loss at a weaker one', () => {
    expect(settlementDifference('1000.00', '131.00', '129.00')).toBe(20_000_000n); // +2,000.00
    expect(settlementDifference('1000.00', '127.50', '129.00')).toBe(-15_000_000n); // -1,500.00
    expect(settlementDifference('1000.00', '129.00', '129.00')).toBe(0n);
  });

  it('revalues an asset up or down, and a liability the other way', () => {
    expect(revaluationDifference('500.00', '129.00', '131.00')).toBe(10_000_000n);
    expect(revaluationDifference('500.00', '131.00', '129.00')).toBe(-10_000_000n);
    // credit balance (negative): the customer is owed more shillings when the dollar strengthens
    expect(revaluationDifference('-500.00', '129.00', '131.00')).toBe(-10_000_000n);
  });

  it('shows whole cents, rounding half away from zero', () => {
    expect(toCentsRounded(12_345n)).toBe(123);
    expect(toCentsRounded(12_350n)).toBe(124);
    expect(toCentsRounded(-12_350n)).toBe(-124);
    expect(toCentsRounded(0n)).toBe(0);
  });
});

describe('the shop rate from the books rate', () => {
  it('is the exact inverse, to eight decimals', () => {
    expect(displayRate('129.5')).toBe('0.00772201');
    expect(displayRate('129.50000000')).toBe('0.00772201');
    expect(displayRate('100')).toBe('0.01000000');
    expect(displayRate('0.5')).toBe('2.00000000');
    expect(displayRate('1')).toBe('1.00000000');
  });

  it('rounds half up', () => {
    // 1 / 3 = 0.33333333…; 1 / 6 = 0.16666666… rounds up.
    expect(displayRate('3')).toBe('0.33333333');
    expect(displayRate('6')).toBe('0.16666667');
  });

  it('says nothing for a rate that is not one, or one too large to show a price with', () => {
    expect(displayRate('0')).toBeNull();
    expect(displayRate('abc')).toBeNull();
    expect(displayRate('-5')).toBeNull();
    expect(displayRate('1.123456789')).toBeNull();
    expect(displayRate('1000000000')).toBeNull();
  });

  it('turns a price in the books currency into the foreign one the same way the shop does', () => {
    const rate = displayRate('129.5');
    expect(rate).not.toBeNull();
    // 12,950 shillings is 100 dollars, give or take the eight decimals.
    expect(Math.round(12950 * Number(rate))).toBe(100);
  });
});
