import { describe, expect, it } from 'vitest';
import { closeDayProblem, decideProblem, readDecision, readTillCount, shortageNeedsApproval, tillProblem } from './settle';

describe('which shortages need a manager', () => {
  it('is those worth more than the limit, and all of them when the limit is nothing', () => {
    expect(shortageNeedsApproval(1000, 1000)).toBe(false);
    expect(shortageNeedsApproval(1000.01, 1000)).toBe(true);
    expect(shortageNeedsApproval(1, 0)).toBe(true);
    expect(shortageNeedsApproval(0, 0)).toBe(false);
  });
});

describe('deciding a shortage', () => {
  const ok = { dayStatus: 'reconciling', decided: false, value: 500, limit: 1000, mayApprove: false, isRep: false };
  it('reads a reason of 3 to 300 characters', () => {
    expect(readDecision({ reason: '  a case  broke ' })).toEqual({ ok: true, reason: 'a case broke' });
    expect(readDecision({ reason: 'no' })).toMatchObject({ ok: false });
    expect(readDecision(null)).toMatchObject({ ok: false });
    expect(readDecision({ reason: 'x'.repeat(301) })).toMatchObject({ ok: false });
  });
  it('is for the day being counted, once, and not by the rep', () => {
    expect(decideProblem(ok)).toBeNull();
    expect(decideProblem({ ...ok, dayStatus: 'returning' })).toContain('being counted');
    expect(decideProblem({ ...ok, decided: true })).toContain('already been decided');
    expect(decideProblem({ ...ok, isRep: true })).toContain('does not decide');
  });
  it('needs a manager above the limit', () => {
    expect(decideProblem({ ...ok, value: 1500 })).toBe('This shortage is worth KES 1500, above KES 1000: a manager decides it.');
    expect(decideProblem({ ...ok, value: 1500, mayApprove: true })).toBeNull();
  });
});

describe('counting the till', () => {
  it('reads the cash counted and an optional reason', () => {
    expect(readTillCount({ counted: '1250.50', reason: ' short by a note ' })).toEqual({ ok: true, counted: 1250.5, reason: 'short by a note' });
    expect(readTillCount({ counted: 0 })).toEqual({ ok: true, counted: 0, reason: '' });
    for (const counted of [undefined, '', -1, 'x', 10.005, 200_000_000]) expect(readTillCount({ counted })).toMatchObject({ ok: false });
  });
  it('is while the day is being counted and the till is open', () => {
    expect(tillProblem({ dayStatus: 'reconciling', shift: 'open' })).toBeNull();
    expect(tillProblem({ dayStatus: 'returning', shift: 'open' })).toContain('while the day is being counted');
    expect(tillProblem({ dayStatus: 'reconciling', shift: null })).toContain('no till');
    expect(tillProblem({ dayStatus: 'reconciling', shift: 'closing' })).toContain('waiting for approval');
    expect(tillProblem({ dayStatus: 'reconciling', shift: 'closed' })).toContain('already closed');
  });
});

describe('closing the day', () => {
  const ok = { dayStatus: 'reconciling', hasVan: true, unload: 'received' as const, productsOnVan: 0, undecided: 0, shift: 'closed' as const };
  it('needs the stock back, every shortage decided and the till closed', () => {
    expect(closeDayProblem(ok)).toBeNull();
    expect(closeDayProblem({ ...ok, hasVan: false, unload: 'none', shift: null })).toBeNull();
    expect(closeDayProblem({ ...ok, dayStatus: 'returning' })).toContain('being counted');
    expect(closeDayProblem({ ...ok, unload: 'none', productsOnVan: 2 })).toContain('still has stock');
    expect(closeDayProblem({ ...ok, undecided: 1 })).toBe('1 shortage is still to be decided.');
    expect(closeDayProblem({ ...ok, undecided: 3 })).toBe('3 shortages are still to be decided.');
    expect(closeDayProblem({ ...ok, shift: 'open' })).toContain('not been counted');
    expect(closeDayProblem({ ...ok, shift: 'closing' })).toContain('waiting for approval');
  });
});
