import { describe, expect, it } from 'vitest';
import { isWellFormedTrackingToken, maskEmail } from './tracking-token';

describe('the tracking token', () => {
  it('accepts 32 characters of the alphabet and nothing else', () => {
    expect(isWellFormedTrackingToken('Abcdefghijklmnopqrstuvwxyz012345')).toBe(true);
    expect(isWellFormedTrackingToken('a-b_c-d_e-f_g-h_i-j_k-l_m-n_o-p_')).toBe(true);
    expect(isWellFormedTrackingToken('short')).toBe(false);
    expect(isWellFormedTrackingToken('A'.repeat(33))).toBe(false);
    expect(isWellFormedTrackingToken(`${'A'.repeat(31)}!`)).toBe(false);
    expect(isWellFormedTrackingToken(`${'A'.repeat(31)} `)).toBe(false);
    expect(isWellFormedTrackingToken("' OR 1=1 --".padEnd(32, 'x'))).toBe(false);
    expect(isWellFormedTrackingToken(undefined)).toBe(false);
    expect(isWellFormedTrackingToken(12345)).toBe(false);
  });
  it('masks an address for a list', () => {
    expect(maskEmail('wanjiru@example.com')).toBe('w***@example.com');
    expect(maskEmail(null)).toBe('');
    expect(maskEmail('nonsense')).toBe('***');
  });
});
