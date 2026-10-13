import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, autoApplyAmount, checkCredit, checkDebit, pickPolicy, type PolicyRow } from './wallet';

const row = (o: Partial<PolicyRow>): PolicyRow => ({ ...DEFAULT_POLICY, groupCode: null, effectiveFrom: '2026-01-01', ...o });
const w = (balanceCents: number, status: 'active' | 'frozen' = 'active') => ({ status, balanceCents });

describe('credit policy', () => {
  it('with nothing set, nothing changes: no wallet', () => {
    expect(pickPolicy([], 'DOMESTIC', '2026-10-12')).toMatchObject({ walletEnabled: false, source: 'default' });
  });
  it('the newest row in force wins; a future row waits', () => {
    const rows = [row({ walletEnabled: false }), row({ effectiveFrom: '2026-06-01', walletEnabled: true }), row({ effectiveFrom: '2027-01-01', walletEnabled: false })];
    expect(pickPolicy(rows, null, '2026-10-12').walletEnabled).toBe(true);
    expect(pickPolicy(rows, null, '2026-03-01').walletEnabled).toBe(false);
  });
  it('a group row overrides the company, and the company keeps the name', () => {
    const rows = [row({ walletEnabled: true, label: 'Store credit' }), row({ groupCode: 'WHOLESALE', walletEnabled: false, label: 'Other' })];
    expect(pickPolicy(rows, 'WHOLESALE', '2026-10-12')).toMatchObject({ walletEnabled: false, source: 'group', label: 'Store credit' });
    expect(pickPolicy(rows, 'RETAIL', '2026-10-12')).toMatchObject({ walletEnabled: true, source: 'company' });
  });
});

describe('wallet rules', () => {
  const on = { ...DEFAULT_POLICY, walletEnabled: true };
  it('credits need the wallet on, deposits allowed, not frozen, and room', () => {
    expect(checkCredit(DEFAULT_POLICY, w(0), 100, 'overpayment')?.code).toBe('WALLET_OFF');
    expect(checkCredit({ ...on, allowDeposits: false }, w(0), 100, 'deposit')?.code).toBe('DEPOSITS_OFF');
    expect(checkCredit({ ...on, allowDeposits: false }, w(0), 100, 'overpayment')).toBeNull();
    expect(checkCredit(on, w(0, 'frozen'), 100, 'deposit')?.code).toBe('WALLET_FROZEN');
    expect(checkCredit({ ...on, maxCents: 1000 }, w(900), 200, 'deposit')?.code).toBe('WALLET_LIMIT');
    expect(checkCredit({ ...on, maxCents: 1000 }, w(900), 100, 'deposit')).toBeNull();
    expect(checkCredit(on, w(0), 0, 'deposit')?.code).toBe('AMOUNT_INVALID');
  });
  it('debits can never take more than is there', () => {
    expect(checkDebit(on, w(500), 501)?.code).toBe('WALLET_INSUFFICIENT');
    expect(checkDebit(on, w(500), 500)).toBeNull();
    expect(checkDebit(on, w(500, 'frozen'), 1)?.code).toBe('WALLET_FROZEN');
  });
  it('the wallet pays the lesser of what it holds and what is owed, only when asked to', () => {
    expect(autoApplyAmount({ ...on, autoApply: 'oldest_first' }, 300, 1000)).toBe(300);
    expect(autoApplyAmount({ ...on, autoApply: 'oldest_first' }, 3000, 1000)).toBe(1000);
    expect(autoApplyAmount(on, 3000, 1000)).toBe(0);
    expect(autoApplyAmount({ ...DEFAULT_POLICY, autoApply: 'oldest_first' }, 3000, 1000)).toBe(0);
  });
});
