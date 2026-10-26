import { describe, expect, it } from 'vitest';
import { baseCents, isCurrencyCode, scaledRate, settlementGain } from './vendor-fx';

describe('vendor foreign currency', () => {
  it('reads rates exactly and refuses what is not a rate', () => {
    expect(scaledRate('129.5')).toBe(12_950_000_000n);
    expect(scaledRate('0.00000001')).toBe(1n);
    expect(scaledRate('0')).toBeNull();
    expect(scaledRate('-1')).toBeNull();
    expect(scaledRate('1e3')).toBeNull();
    expect(scaledRate('1.123456789')).toBeNull();
  });
  it('values cents at a rate, rounding half away from zero', () => {
    expect(baseCents(10_000, '129.5')).toBe(1_295_000);
    expect(baseCents(1, '129.5')).toBe(130);
    expect(baseCents(1, '0.4')).toBe(0);
    expect(baseCents(1, '0.5')).toBe(1);
    expect(baseCents(-1, '0.5')).toBe(-1);
    expect(baseCents(12_345, '1')).toBe(12_345);
    expect(() => baseCents(1, 'x')).toThrow();
  });
  it('says what paying at another rate gained or lost', () => {
    // 100.00 USD booked at 130, paid at 128: the liability was 13,000.00 and it cost 12,800.00 to settle: a gain of 200.00.
    expect(settlementGain(10_000, '130', '128')).toBe(20_000);
    expect(settlementGain(10_000, '128', '130')).toBe(-20_000);
    expect(settlementGain(10_000, '129.5', '129.5')).toBe(0);
  });
  it('knows a currency code', () => {
    expect([isCurrencyCode('USD'), isCurrencyCode('usd'), isCurrencyCode('US')]).toEqual([true, false, false]);
  });
});
