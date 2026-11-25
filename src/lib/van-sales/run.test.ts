import { describe, expect, it } from 'vitest';
import { FINISH_OUTCOMES, VISIT_MOVES, arrivalProblem, canMoveVisit, goOutProblem, metresBetween, readFinish, readFloat, readPosition, readWhy } from './run';

describe('the float counted into the till', () => {
  it('is nothing or more, in shillings', () => {
    expect(readFloat(0)).toEqual({ ok: true, amount: 0 });
    expect(readFloat('2500.505')).toEqual({ ok: true, amount: 2500.51 });
    expect(readFloat(1_000)).toEqual({ ok: true, amount: 1000 });
  });
  it.each([[-1], ['lots'], [''], [null], [undefined], [Number.NaN], [1e15]])('refuses %j in words', (raw) => {
    const r = readFloat(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('cash counted into the van');
  });
});

describe('a position', () => {
  it('is none, or a place on the earth, or refused in words', () => {
    expect(readPosition(undefined)).toEqual({ ok: true, point: null });
    expect(readPosition(null)).toEqual({ ok: true, point: null });
    expect(readPosition({ latitude: -1.2921, longitude: 36.8219 })).toEqual({ ok: true, point: { latitude: -1.2921, longitude: 36.8219 } });
    expect(readPosition('here').ok).toBe(false);
    expect(readPosition({ latitude: 95, longitude: 0 }).ok).toBe(false);
    expect(readPosition({ latitude: 'x', longitude: 0 }).ok).toBe(false);
  });
  it('is measured in whole metres', () => {
    const a = { latitude: -1.2921, longitude: 36.8219 };
    expect(metresBetween(a, a)).toBe(0);
    expect(metresBetween(a, { latitude: -1.2921, longitude: 36.8229 })).toBeGreaterThan(100);
    expect(metresBetween(a, { latitude: -1.2921, longitude: 36.8229 })).toBeLessThan(120);
  });
});

describe('starting a visit near the customer', () => {
  const here = { latitude: -1.29, longitude: 36.82 };
  it('never stops a visit when the company only records the distance', () => {
    expect(arrivalProblem({ position: 'record', nearMetres: 200 }, 'Duka', null, null)).toBeNull();
    expect(arrivalProblem({ position: 'record', nearMetres: 200 }, 'Duka', here, 5000)).toBeNull();
  });
  it('needs a position and a distance within the limit when the company requires it', () => {
    const rule = { position: 'require' as const, nearMetres: 200 };
    expect(arrivalProblem(rule, 'Duka', null, null)).toContain('needs your position');
    expect(arrivalProblem(rule, 'Duka', here, 340)).toBe('You are 340 m from Duka. Get within 200 m to start the visit.');
    expect(arrivalProblem(rule, 'Duka', here, 200)).toBeNull();
    expect(arrivalProblem(rule, 'Duka', here, null)).toBeNull(); // the customer has no pin to measure from
  });
});

describe('what a visit can do', () => {
  it('goes from to-visit to at-the-customer to done, and can be skipped or found shut', () => {
    expect(VISIT_MOVES.planned).toEqual(['arrived', 'skipped', 'closed_shop']);
    expect(VISIT_MOVES.arrived).toEqual(['done', 'closed_shop']);
    expect(VISIT_MOVES.done).toEqual([]);
    expect(canMoveVisit('planned', 'done')).toBe(false);
    expect(canMoveVisit('arrived', 'skipped')).toBe(false);
    expect(canMoveVisit('skipped', 'arrived')).toBe(false);
    expect(canMoveVisit('arrived', 'closed_shop')).toBe(true);
  });
  it('ends with no sale only with a reason', () => {
    expect(FINISH_OUTCOMES).toEqual(['sold', 'no_sale']);
    expect(readFinish({ outcome: 'sold' })).toEqual({ ok: true, finish: { outcome: 'sold', reason: null } });
    expect(readFinish({ outcome: 'no_sale', reason: ' Has enough stock ' })).toEqual({ ok: true, finish: { outcome: 'no_sale', reason: 'Has enough stock' } });
    expect(readFinish({ outcome: 'no_sale' }).ok).toBe(false);
    expect(readFinish({ outcome: 'no_sale', reason: 'no' }).ok).toBe(false);
    expect(readFinish({ outcome: 'won', reason: 'fine reason' }).ok).toBe(false);
    expect(readFinish(null).ok).toBe(false);
    expect(readWhy('x'.repeat(301)).ok).toBe(false);
  });
});

describe('a day going out', () => {
  it('needs a signed load when it sells from a van, and nothing when it only takes orders', () => {
    expect(goOutProblem({ status: 'loading', mode: 'van_sell', loadSigned: true })).toBeNull();
    expect(goOutProblem({ status: 'loading', mode: 'both', loadSigned: true })).toBeNull();
    expect(goOutProblem({ status: 'loading', mode: 'van_sell', loadSigned: false })).toContain('sign for it');
    expect(goOutProblem({ status: 'planned', mode: 'van_sell', loadSigned: false })).toContain('Make up the load');
    expect(goOutProblem({ status: 'planned', mode: 'pre_sell', loadSigned: false })).toBeNull();
  });
  it('is refused for a day that is out already or has run its course', () => {
    expect(goOutProblem({ status: 'out', mode: 'van_sell', loadSigned: true })).toBe('This day is already out.');
    for (const status of ['returning', 'reconciling', 'closed', 'cancelled'] as const) expect(goOutProblem({ status, mode: 'van_sell', loadSigned: true })).toContain('run its course');
  });
});
