import { describe, expect, it } from 'vitest';
import { optionalAmount, standardPriceProblem } from './commercial-rules';

describe('optionalAmount', () => {
  it('reads nothing as none, and anything else as a number that may be rubbish', () => {
    expect([undefined, null, ''].map(optionalAmount)).toEqual([null, null, null]);
    expect(optionalAmount(5)).toBe(5);
    expect(optionalAmount('7.5')).toBe(7.5);
    expect(Number.isNaN(optionalAmount('abc'))).toBe(true);
  });
});

describe('standardPriceProblem', () => {
  it('accepts none (it follows the selling price)', () => {
    expect(standardPriceProblem(null, true)).toBeNull();
  });
  it('refuses negative and rubbish', () => {
    expect(standardPriceProblem(-1, false)).toContain('must be 0 or more');
    expect(standardPriceProblem(Number.NaN, false)).toContain('must be 0 or more');
  });
  it('allows zero only for something not for sale', () => {
    expect(standardPriceProblem(0, false)).toBeNull();
    expect(standardPriceProblem(0, true)).toContain('above zero');
    expect(standardPriceProblem(250, true)).toBeNull();
  });
});
