import { describe, expect, it } from 'vitest';
import { netWords, rateFormProblem, rateWords } from './exchange-rate-form';

describe('rate form', () => {
  const ok = { currency: 'USD', effectiveOn: '2026-10-17', rate: '129.5' };
  it('accepts a good one and explains a bad one', () => {
    expect(rateFormProblem(ok, '2026-10-17')).toBeNull();
    expect(rateFormProblem({ ...ok, currency: '' }, '2026-10-17')).toContain('currency');
    expect(rateFormProblem({ ...ok, effectiveOn: '' }, '2026-10-17')).toContain('day');
    expect(rateFormProblem({ ...ok, effectiveOn: '2026-10-16' }, '2026-10-17')).toContain('passed');
    expect(rateFormProblem({ ...ok, rate: '0' }, '2026-10-17')).toContain('above zero');
    expect(rateFormProblem({ ...ok, rate: '1,5' }, '2026-10-17')).toContain('above zero');
  });
  it('reads a rate and a result in words', () => {
    expect(rateWords('USD', '129.50000000', 'KES')).toBe('1 USD = 129.50 KES');
    expect(rateWords('USD', '129.12345678', 'KES')).toBe('1 USD = 129.12345678 KES');
    expect(netWords('120.5000')).toBe('Gain of 120.50');
    expect(netWords('-3')).toBe('Loss of 3.00');
    expect(netWords('0.0000')).toBe('No difference');
  });
});
