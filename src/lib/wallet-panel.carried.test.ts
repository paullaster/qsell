import { describe, expect, it } from 'vitest';
import { carriedWords } from './wallet-panel';

describe('carriedWords', () => {
  it('says nothing for a wallet in the books\' currency', () => {
    expect(carriedWords('KES', null, '0.0000')).toBeNull();
  });
  it('says the rate without trailing zeros and what it is worth', () => {
    expect(carriedWords('USD', '129.00000000', '12,900.0000')).toBe('Booked at 129 for each USD, so worth 12,900.0000 in the books.');
    expect(carriedWords('USD', '128.50000000', '6425')).toBe('Booked at 128.5 for each USD, so worth 6425 in the books.');
    expect(carriedWords('USD', '128.12345678', '1')).toContain('128.12345678');
  });
});
