import { describe, expect, it } from 'vitest';
import { hueOf, initials, kes } from './tile-style';

describe('tile style', () => {
  it('takes two letters from the name', () => {
    expect(initials('Blue Band 500g')).toBe('BB');
    expect(initials('Milk')).toBe('MI');
    expect(initials('  ')).toBe('?');
  });
  it('gives a product the same colour every time, within the colour wheel', () => {
    expect(hueOf('Sugar')).toBe(hueOf('Sugar'));
    expect(hueOf('Sugar')).toBeGreaterThanOrEqual(0);
    expect(hueOf('Sugar')).toBeLessThan(360);
  });
  it('writes money with two places', () => {
    expect(kes(1234.5)).toBe('KES 1,234.50');
  });
});
