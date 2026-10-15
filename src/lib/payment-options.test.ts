import { describe, expect, it } from 'vitest';
import { PROVIDER_ENVIRONMENTS, labelOf, refundDestination, savedHint, stateChoices, suggestGlAccount, words } from './payment-options';

describe('payment options', () => {
  it('shows the words of a saved value, or the value itself when it is unknown', () => {
    expect(labelOf(PROVIDER_ENVIRONMENTS, 'staging')).toBe('Testing (sandbox)');
    expect(labelOf(PROVIDER_ENVIRONMENTS, 'moon')).toBe('moon');
    expect(labelOf(PROVIDER_ENVIRONMENTS, '')).toBeNull();
    expect(labelOf(PROVIDER_ENVIRONMENTS, null)).toBeNull();
  });

  it('turns state codes into words', () => {
    expect(words('awaiting_verification')).toBe('awaiting verification');
    expect(stateChoices(['in_doubt'])).toEqual([{ id: 'in_doubt', label: 'in doubt' }]);
  });

  it('suggests a G/L account only when every method on the bank account agrees', () => {
    const m = (bank: string, gl: string) => ({ bankAccountId: bank, glAccountId: gl, glLabel: `label ${gl}` });
    expect(suggestGlAccount([m('b1', 'g1'), m('b1', 'g1'), m('b2', 'g2')], 'b1')).toEqual({ id: 'g1', label: 'label g1' });
    expect(suggestGlAccount([m('b1', 'g1'), m('b1', 'g2')], 'b1')).toBeNull();
    expect(suggestGlAccount([m('b1', 'g1')], 'b9')).toBeNull();
  });

  it('saves the refund setting as none, manual or automatic', () => {
    expect(refundDestination(false, 'automatic')).toBe('none');
    expect(refundDestination(true, 'automatic')).toBe('automatic');
    expect(refundDestination(true, undefined)).toBe('manual');
    expect(refundDestination(true, 'manual')).toBe('manual');
  });

  it('shows what is saved under a credential field only when something is', () => {
    expect(savedHint({ key: '****1234' }, 'key')).toBe('Saved: ****1234');
    expect(savedHint({ key: '' }, 'key')).toBeUndefined();
    expect(savedHint({}, 'key')).toBeUndefined();
    expect(savedHint(null, 'key')).toBeUndefined();
  });
});
