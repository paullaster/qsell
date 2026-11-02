import { describe, expect, it } from 'vitest';
import { splitTax } from './delivery-tax';

describe('splitTax', () => {
  it('adds tax to a charge quoted without it', () => {
    expect(splitTax(350, 16, false)).toEqual({ net: 350, tax: 56, gross: 406 });
  });
  it('takes tax out of a charge that includes it, keeping what the customer pays', () => {
    expect(splitTax(406, 16, true)).toEqual({ net: 350, tax: 56, gross: 406 });
    expect(splitTax(350, 16, true)).toEqual({ net: 301.72, tax: 48.28, gross: 350 });
  });
  it('charges no tax at a rate of nothing, whatever the setting', () => {
    expect(splitTax(350, 0, false)).toEqual({ net: 350, tax: 0, gross: 350 });
    expect(splitTax(350, 0, true)).toEqual({ net: 350, tax: 0, gross: 350 });
    expect(splitTax(350, Number.NaN, false).tax).toBe(0);
    expect(splitTax(350, -5, false).tax).toBe(0);
  });
  it('always adds up to the cent', () => {
    for (const amount of [0, 0.01, 99.99, 123.45, 777, 1999.99]) {
      for (const inclusive of [false, true]) {
        const s = splitTax(amount, 16, inclusive);
        expect(Math.round((s.net + s.tax) * 100) / 100).toBe(s.gross);
      }
    }
  });
  it('is free when the charge is free', () => {
    expect(splitTax(0, 16, false)).toEqual({ net: 0, tax: 0, gross: 0 });
  });
});
