import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, autoApplyAmount, averageRate, checkCredit, checkDebit, checkExpiry, expiryState, lapseDate, pickPolicy, type PolicyRow } from './wallet';

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

describe('a balance that lapses', () => {
  const policy = { expiryDays: 90, expiryNoticeDays: 30 };
  const touched = new Date('2026-01-01T00:00:00Z');
  const after = (days: number) => new Date(touched.getTime() + days * 86_400_000);

  it('never lapses when the policy has no expiry', () => {
    expect(expiryState(touched, after(5000), { expiryDays: null, expiryNoticeDays: 30 })).toBe('never');
    expect(lapseDate(touched, null)).toBeNull();
  });

  it('is safe, then about to lapse inside the warning period, then lapsed on the day', () => {
    expect(expiryState(touched, after(59), policy)).toBe('ok');
    expect(expiryState(touched, after(60), policy)).toBe('soon');
    expect(expiryState(touched, after(89), policy)).toBe('soon');
    expect(expiryState(touched, after(90), policy)).toBe('lapsed');
    expect(lapseDate(touched, 90)).toBe('2026-04-01');
  });

  it('checks the settings as typed', () => {
    expect(checkExpiry(null, 30)).toBeNull();
    expect(checkExpiry(90, 30)).toBeNull();
    expect(checkExpiry(10, 5)).toContain('30 to 3,650');
    expect(checkExpiry(90.5, 5)).toContain('30 to 3,650');
    expect(checkExpiry(90, 90)).toContain('shorter');
    expect(checkExpiry(90, -1)).toContain('0 to 365');
  });
});

describe('the rate a foreign wallet is carried at', () => {
  it('is what the balance is worth per unit held, to 8 decimals', () => {
    // 100.00 USD booked as 12,950.0000 KES
    expect(averageRate(10_000, 129_500_000n)).toBe('129.50000000');
    // 100.00 at 129 plus 50.00 at 131: 19,450 for 150.00
    expect(averageRate(15_000, 194_500_000n)).toBe('129.66666667');
  });

  it('has none for an empty wallet', () => {
    expect(averageRate(0, 0n)).toBeNull();
    expect(averageRate(100, 0n)).toBeNull();
  });
});
