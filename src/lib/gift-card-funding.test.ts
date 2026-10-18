import { describe, expect, it } from 'vitest';
import { FUNDING_CHOICES, fundingInput, fundingProblem } from './gift-card-funding';

describe('how gift cards were paid for', () => {
  it('has to be said, and a sale needs the payment method', () => {
    expect(fundingProblem(null, null)).toContain('Say how');
    expect(fundingProblem('sold', null)).toContain('payment method');
    expect(fundingProblem('sold', 'm1')).toBeNull();
    expect(fundingProblem('complimentary', null)).toBeNull();
  });

  it('sends a method only for cards that were sold', () => {
    expect(fundingInput('sold', 'm1')).toEqual({ kind: 'sold', paymentMethodId: 'm1' });
    expect(fundingInput('complimentary', 'm1')).toEqual({ kind: 'complimentary' });
    expect(fundingInput('sold', null)).toBeUndefined();
    expect(fundingInput(null, 'm1')).toBeUndefined();
  });

  it('offers the two ways, each explained', () => {
    expect(FUNDING_CHOICES.map((c) => c.id)).toEqual(['sold', 'complimentary']);
    for (const c of FUNDING_CHOICES) expect(c.hint.length).toBeGreaterThan(10);
  });
});
