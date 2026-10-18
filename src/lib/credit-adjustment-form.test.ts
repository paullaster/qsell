import { describe, expect, it } from 'vitest';
import { adjustmentInput, adjustmentKey, adjustmentProblem, isKind, outcomeMessage, type AdjustmentForm } from './credit-adjustment-form';

const wallet: AdjustmentForm = { customerId: 'c1', kind: 'wallet_decrease', sourceKind: null, sourceId: null, amount: ' 40 ', currency: '', reasonCode: 'OTHER', reasonText: ' fix ' };

describe('the credit adjustment form', () => {
  it('needs a customer, a kind, an amount above zero and a reason; giving up credit also needs the credit', () => {
    expect(adjustmentProblem(wallet)).toBeNull();
    expect(adjustmentProblem({ ...wallet, customerId: null })).toContain('customer');
    expect(adjustmentProblem({ ...wallet, kind: null })).toContain('what to do');
    expect(adjustmentProblem({ ...wallet, kind: 'waive_excess' })).toContain('which credit');
    expect(adjustmentProblem({ ...wallet, kind: 'waive_excess', sourceId: 'r1' })).toBeNull();
    expect(adjustmentProblem({ ...wallet, amount: '0' })).toContain('above zero');
    expect(adjustmentProblem({ ...wallet, amount: 'abc' })).toContain('above zero');
    expect(adjustmentProblem({ ...wallet, reasonCode: null })).toContain('reason');
    expect(adjustmentProblem({ ...wallet, currency: 'KE' })).toContain('three letters');
    expect(adjustmentProblem({ ...wallet, currency: 'usd' })).toBeNull();
  });

  it('sends the source only when giving up credit, and trimmed text', () => {
    expect(adjustmentInput({ ...wallet, sourceKind: 'receipt_unapplied', sourceId: 'r1' }, 'n')).toMatchObject({ kind: 'wallet_decrease', sourceKind: undefined, sourceId: undefined, amount: '40', reasonText: 'fix' });
    expect(adjustmentInput({ ...wallet, kind: 'waive_excess', sourceKind: 'receipt_unapplied', sourceId: 'r1', currency: 'USD' }, 'n')).toMatchObject({ sourceKind: 'receipt_unapplied', sourceId: 'r1', currency: undefined });
    expect(adjustmentInput({ ...wallet, currency: ' usd ' }, 'n')).toMatchObject({ currency: 'USD' });
    expect(adjustmentInput(wallet, 'n').currency).toBeUndefined();
  });

  it('gives the same key for the same request and another for another', () => {
    expect(adjustmentKey(wallet, 'n')).toBe(adjustmentKey({ ...wallet }, 'n'));
    expect(adjustmentKey(wallet, 'n')).not.toBe(adjustmentKey({ ...wallet, amount: '41' }, 'n'));
    expect(adjustmentKey(wallet, 'n')).not.toBe(adjustmentKey(wallet, 'm'));
  });

  it('knows the kinds it offers and what happened after sending', () => {
    expect(isKind('waive_excess')).toBe(true);
    expect(isKind('wallet_expiry')).toBe(false);
    expect(isKind(null)).toBe(false);
    expect(outcomeMessage('pending_approval')).toContain('Nothing changes');
    expect(outcomeMessage('applied')).toBe('Done.');
    expect(outcomeMessage('requested')).toContain('Someone other than you');
  });
});
