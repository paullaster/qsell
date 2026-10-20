import { describe, expect, it } from 'vitest';
import {
  divideRounded,
  fitsPlaces,
  formatDecimal,
  parseDecimal,
  quantityFits,
  roundQty,
} from './decimal';

describe('parseDecimal', () => {
  it('reads plain decimals exactly, scaled by 10^10', () => {
    expect(parseDecimal('1')).toBe(10_000_000_000n);
    expect(parseDecimal('0.001')).toBe(10_000_000n);
    expect(parseDecimal(' 12.5 ')).toBe(125_000_000_000n);
    expect(parseDecimal('-0.5')).toBe(-5_000_000_000n);
  });

  it('refuses anything else', () => {
    for (const bad of [
      '',
      'abc',
      '1,5',
      '1e3',
      '.5',
      '5.',
      '1.12345678901',
      '123456789012345',
      '--1',
      '1 2',
    ]) {
      expect(parseDecimal(bad)).toBeNull();
    }
  });
});

describe('formatDecimal', () => {
  it('writes the number with the places asked for, rounding halves away from zero', () => {
    expect(formatDecimal(parseDecimal('1.2345') ?? 0n, 3)).toBe('1.235');
    expect(formatDecimal(parseDecimal('-1.2345') ?? 0n, 3)).toBe('-1.235');
    expect(formatDecimal(parseDecimal('2.5') ?? 0n, 0)).toBe('3');
    expect(formatDecimal(parseDecimal('0.0004') ?? 0n, 3)).toBe('0.000');
    expect(formatDecimal(parseDecimal('7') ?? 0n, 2)).toBe('7.00');
  });

  it('round-trips at full precision', () => {
    expect(formatDecimal(parseDecimal('0.1234567891') ?? 0n)).toBe('0.1234567891');
  });
});

describe('divideRounded', () => {
  it('rounds halves away from zero for either sign', () => {
    expect(divideRounded(5n, 2n)).toBe(3n);
    expect(divideRounded(-5n, 2n)).toBe(-3n);
    expect(divideRounded(5n, -2n)).toBe(-3n);
    expect(divideRounded(4n, 3n)).toBe(1n);
  });
});

describe('fitsPlaces', () => {
  it('says whether a quantity has no more digits than a unit allows', () => {
    expect(fitsPlaces('2', 0)).toBe(true);
    expect(fitsPlaces('2.5', 0)).toBe(false);
    expect(fitsPlaces('2.500', 3)).toBe(true);
    expect(fitsPlaces('2.5001', 3)).toBe(false);
    expect(fitsPlaces('x', 3)).toBe(false);
  });
});

describe('roundQty', () => {
  it('removes floating point drift from sums and differences, to three decimals', () => {
    expect(roundQty(0.1 + 0.2)).toBe(0.3);
    expect(roundQty(12.645 - 0.645)).toBe(12);
    expect(roundQty(1.0005)).toBe(1.001);
    expect(roundQty(-1.0005)).toBe(-1.001);
    expect(roundQty(2.5)).toBe(2.5);
    expect(roundQty(0)).toBe(0);
  });
});

describe('quantityFits', () => {
  it('says whether a quantity has only the decimals a unit allows', () => {
    expect(quantityFits(3, 0)).toBe(true);
    expect(quantityFits(2.5, 0)).toBe(false);
    expect(quantityFits(2.5, 1)).toBe(true);
    expect(quantityFits(0.1 + 0.2, 1)).toBe(true);
    expect(quantityFits(1.2345, 3)).toBe(false);
    expect(quantityFits(1.234, 3)).toBe(true);
    expect(quantityFits(Number.NaN, 3)).toBe(false);
    expect(quantityFits(Infinity, 3)).toBe(false);
  });
});
