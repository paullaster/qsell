import { describe, expect, it } from 'vitest';
import { checkClose, DEFAULT_TOLERANCE, expectedCash, KES_DENOMINATIONS, parseAmount, parseCount, toleranceProblem, totalOf, varianceKind, varianceOf } from './shift-rules';

describe('counting the cash', () => {
  it('adds up notes and coins, largest first, and drops the ones counted none of', () => {
    const r = parseCount({ counted: [{ value: 50, count: 3 }, { value: 1000, count: 2 }, { value: 5, count: 0 }] }, 'float');
    expect(r).toEqual({ ok: true, counted: [{ value: 1000, count: 2 }, { value: 50, count: 3 }], total: 2150 });
    expect(totalOf([{ value: 20, count: 7 }])).toBe(140);
    expect(KES_DENOMINATIONS[0]).toBe(1000);
  });

  it('takes a quick total instead, and refuses what cannot be a count', () => {
    expect(parseCount({ total: 1234.5 }, 'float')).toEqual({ ok: true, counted: [], total: 1234.5 });
    expect(parseCount({ total: -1 }, 'float').ok).toBe(false);
    expect(parseCount({ total: Number.NaN }, 'float').ok).toBe(false);
    expect(parseCount({ counted: [{ value: 7, count: 1 }] }, 'float').ok).toBe(false);
    expect(parseCount({ counted: [{ value: 50, count: 1 }, { value: 50, count: 2 }] }, 'float').ok).toBe(false);
    expect(parseCount({ counted: [{ value: 50, count: 1.5 }] }, 'float').ok).toBe(false);
    expect(parseCount({ counted: [{ value: 50, count: -1 }] }, 'float').ok).toBe(false);
    expect(parseCount(null, 'float')).toEqual({ ok: false, error: 'Count the float.' });
  });

  it('reads an amount as more than nothing with at most two decimals', () => {
    expect(parseAmount(250.5)).toBe(250.5);
    for (const bad of [0, -5, 1.005, Number.NaN, '5', 2e9]) expect(parseAmount(bad)).toBeNull();
  });
});

describe('what the till should hold and the difference', () => {
  it('is the float plus cash sales and cash put in, less cash taken out', () => {
    expect(expectedCash({ openingFloat: 5000, paidIn: 200, paidOut: 150.5, cashSales: 12000.25 })).toBe(17049.75);
    expect(varianceOf(17000, 17049.75)).toBe(-49.75);
    expect(varianceOf(17100, 17049.75)).toBe(50.25);
  });

  it('calls a difference none, within the tolerance (the amount or the percent is enough), or beyond it', () => {
    const t = { amount: 100, percent: 1 };
    expect(varianceKind(0, 5000, t)).toBe('none');
    expect(varianceKind(-99, 5000, t)).toBe('within');
    expect(varianceKind(-120, 20000, t)).toBe('within');
    expect(varianceKind(-120, 5000, t)).toBe('beyond');
    expect(varianceKind(500, 5000, DEFAULT_TOLERANCE)).toBe('beyond');
  });
});

describe('closing a shift', () => {
  const base = { expected: 5000, tolerance: { amount: 100, percent: 1 }, supervisor: false };
  it('needs no reason when the till is right', () => {
    expect(checkClose({ ...base, variance: 0, reason: '' })).toEqual({ ok: true, kind: 'none', route: 'close' });
  });
  it('needs a reason in words for any difference', () => {
    const r = checkClose({ ...base, variance: -40, reason: ' ' });
    expect(r.ok).toBe(false);
    expect(checkClose({ ...base, variance: -40, reason: 'gave wrong change' })).toEqual({ ok: true, kind: 'within', route: 'close' });
    expect(checkClose({ ...base, variance: -40, reason: 'x'.repeat(201) }).ok).toBe(false);
  });
  it('lets only a supervisor close a shift that is out by more than the company allows', () => {
    const refused = checkClose({ ...base, variance: -400, reason: 'short' });
    expect(refused).toEqual({ ok: false, error: 'The difference is more than the company allows a till to be out by. A supervisor has to close this shift.' });
    expect(checkClose({ ...base, variance: -400, reason: 'short', supervisor: true })).toEqual({ ok: true, kind: 'beyond', route: 'close' });
  });
  it('with the approval queue chosen, sends a difference beyond the allowance to it, except a supervisor closing another person\'s shift', () => {
    const beyond = { ...base, variance: -400, reason: 'short', mode: 'approval' as const };
    expect(checkClose({ ...beyond, supervisor: false })).toEqual({ ok: true, kind: 'beyond', route: 'approval' });
    expect(checkClose({ ...beyond, supervisor: true, ownShift: true })).toEqual({ ok: true, kind: 'beyond', route: 'approval' });
    expect(checkClose({ ...beyond, supervisor: true, ownShift: false })).toEqual({ ok: true, kind: 'beyond', route: 'close' });
    expect(checkClose({ ...base, variance: -40, reason: 'gave wrong change', mode: 'approval' })).toEqual({ ok: true, kind: 'within', route: 'close' });
    expect(checkClose({ ...beyond, reason: '', supervisor: true }).ok).toBe(false);
  });
  it('checks the tolerance the company sets', () => {
    expect(toleranceProblem({ amount: 100, percent: 1 })).toBeNull();
    expect(toleranceProblem({ amount: -1, percent: 1 })).not.toBeNull();
    expect(toleranceProblem({ amount: 1, percent: 101 })).not.toBeNull();
  });
});
