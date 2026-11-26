import { describe, expect, it } from 'vitest';
import { cashDropProblem, cashState, cashWords, readCashDrop } from './cash';

describe('reading a cash drop', () => {
  it('reads an amount, where it goes and a note', () => {
    expect(readCashDrop({ amount: 5000, destination: 'safe', note: '  to the  office safe ' })).toEqual({ ok: true, drop: { amount: 5000, destination: 'safe', note: 'to the office safe' } });
    expect(readCashDrop({ amount: '1250.50', destination: 'bank_run' })).toEqual({ ok: true, drop: { amount: 1250.5, destination: 'bank_run', note: null } });
  });
  it('refuses a missing, nil, odd or huge amount, an unknown place and a long note', () => {
    expect(readCashDrop(null)).toMatchObject({ ok: false });
    for (const amount of [undefined, 0, -5, 'x', '', 10.005, 200_000_000]) expect(readCashDrop({ amount, destination: 'safe' })).toMatchObject({ ok: false });
    expect(readCashDrop({ amount: 10, destination: 'home' })).toMatchObject({ ok: false, error: expect.stringContaining('where the cash is going') as string });
    expect(readCashDrop({ amount: 10, destination: 'safe', note: 'x'.repeat(201) })).toMatchObject({ ok: false });
  });
});

describe('the cash on the van against its limit', () => {
  it('is ok, near from nine tenths, over past the limit, and unlimited without one', () => {
    expect(cashState(1000, 10000)).toBe('ok');
    expect(cashState(9000, 10000)).toBe('near');
    expect(cashState(10000, 10000)).toBe('near');
    expect(cashState(10001, 10000)).toBe('over');
    expect(cashState(99999, null)).toBe('no_limit');
    expect(cashState(5, 0)).toBe('no_limit');
  });
  it('says what to do, only when there is something to say', () => {
    expect(cashWords(1000, 10000)).toBeNull();
    expect(cashWords(9500, 10000)).toContain('close to its cash limit');
    expect(cashWords(12500, 10000)).toContain('2500');
    expect(cashWords(5, null)).toBeNull();
  });
});

describe('when a cash drop can be made', () => {
  const ok = { dayStatus: 'out', hasShift: true, cash: 3000, amount: 1000 };
  it('needs the day out or coming back, a till and enough cash in it', () => {
    expect(cashDropProblem(ok)).toBeNull();
    expect(cashDropProblem({ ...ok, dayStatus: 'returning' })).toBeNull();
    expect(cashDropProblem({ ...ok, dayStatus: 'planned' })).toContain('while the day is out');
    expect(cashDropProblem({ ...ok, hasShift: false })).toContain('no till open');
    expect(cashDropProblem({ ...ok, amount: 3000.01 })).toContain('cannot take off more');
    expect(cashDropProblem({ ...ok, amount: 3000 })).toBeNull();
  });
});
