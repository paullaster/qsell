import { describe, expect, it } from 'vitest';
import { MAX_ADJUSTMENT_CENTS, adjustmentCapabilities, canDecide, checkAdjustmentAmount, nextStatuses } from './credit-adjustment';

describe('credit adjustment rules', () => {
  it('a decided or cancelled request never moves again', () => {
    for (const s of ['applied', 'rejected', 'cancelled'] as const) expect(nextStatuses(s)).toEqual([]);
    expect(nextStatuses('requested')).toContain('applied');
    expect(nextStatuses('pending_approval')).not.toContain('pending_approval');
  });

  it('the person who asked can never be the one who decides', () => {
    expect(canDecide({ requestedBy: 'a', decidedBy: 'a' })).toContain('cannot be the one');
    expect(canDecide({ requestedBy: 'a', decidedBy: null })).toContain('Sign in');
    expect(canDecide({ requestedBy: 'a', decidedBy: 'b' })).toBeNull();
  });

  it('refuses nothing, negative and absurd amounts', () => {
    expect(checkAdjustmentAmount(0)).toContain('more than zero');
    expect(checkAdjustmentAmount(-5)).toContain('more than zero');
    expect(checkAdjustmentAmount(1)).toBeNull();
    expect(checkAdjustmentAmount(MAX_ADJUSTMENT_CENTS)).toBeNull();
    expect(checkAdjustmentAmount(MAX_ADJUSTMENT_CENTS + 1)).toContain('too large');
  });

  it('offers what can still be done in each state', () => {
    expect(adjustmentCapabilities('requested')).toEqual({ decide: true, cancel: true, submit: true });
    expect(adjustmentCapabilities('pending_approval')).toEqual({ decide: false, cancel: true, submit: false });
    expect(adjustmentCapabilities('applied')).toEqual({ decide: false, cancel: false, submit: false });
  });
});
