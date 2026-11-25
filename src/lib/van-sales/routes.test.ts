import { describe, expect, it } from 'vitest';
import { movedOrder, readOrder, readPar, readRoute, readStop, vanProblem } from './routes';

const id = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const route = { code: 'kiambu-mon', name: 'Kiambu Monday', branchId: id(1), mode: 'both', defaultVanId: id(2), defaultRepId: id(3) };

describe('reading a route', () => {
  it('takes a code, name, branch, mode and the usual van and rep', () => {
    expect(readRoute(route)).toEqual({ ok: true, route: { ...route, code: 'KIAMBU-MON' } });
    expect(readRoute({ ...route, defaultVanId: '', defaultRepId: null, code: ' a  b ' })).toMatchObject({ ok: true, route: { code: 'A B', defaultVanId: null, defaultRepId: null } });
  });
  it.each([
    [null, 'could not be read'],
    [{ ...route, code: '' }, 'short code'],
    [{ ...route, code: '-ab' }, 'short code'],
    [{ ...route, code: 'x'.repeat(21) }, 'short code'],
    [{ ...route, name: 'K' }, 'name of 2 to 60'],
    [{ ...route, branchId: 'x' }, 'Choose the branch'],
    [{ ...route, mode: 'walking' }, 'van sell, pre-sell, or both'],
    [{ ...route, defaultVanId: 'x' }, 'van from the list'],
    [{ ...route, defaultRepId: 7 }, 'sales rep from the list'],
  ])('refuses %j in words', (raw, words) => {
    const r = readRoute(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });
  it('lets a pre-sell route have no usual van', () => {
    expect(vanProblem('pre_sell', id(2))).toContain('no usual van');
    expect(vanProblem('pre_sell', null)).toBeNull();
    expect(vanProblem('van_sell', id(2))).toBeNull();
    expect(vanProblem('both', id(2))).toBeNull();
  });
});

const stop = { customerId: id(5), visitDays: 0b101, every: 2, anchor: '2026-11-02', note: ' Gate B ' };

describe('reading a stop', () => {
  it('takes a customer, the days, how often, the start date and a note', () => {
    expect(readStop(stop)).toEqual({ ok: true, stop: { ...stop, note: 'Gate B' } });
    expect(readStop({ ...stop, note: '' })).toMatchObject({ ok: true, stop: { note: null } });
  });
  it.each([
    [null, 'could not be read'],
    [{ ...stop, customerId: 'x' }, 'customer from the list'],
    [{ ...stop, visitDays: 0 }, 'at least one day'],
    [{ ...stop, every: 3 }, 'how often'],
    [{ ...stop, anchor: '2026-02-30' }, 'date the visits start'],
    [{ ...stop, note: 'x'.repeat(301) }, '300 characters'],
  ])('refuses %j in words', (raw, words) => {
    const r = readStop(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });
});

describe('reading the usual stock of a van', () => {
  it('takes each product once with a quantity', () => {
    expect(readPar([{ productId: id(1), quantity: 24 }, { productId: 'prod_abc-123', quantity: '0.5' }])).toEqual({ ok: true, rows: [{ productId: id(1), quantity: 24 }, { productId: 'prod_abc-123', quantity: 0.5 }] });
    expect(readPar([])).toEqual({ ok: true, rows: [] });
  });
  it.each([
    ['x', 'could not be read'],
    [[{ productId: '', quantity: 1 }], 'each product from the list'],
    [[{ productId: 5, quantity: 1 }], 'each product from the list'],
    [[{ productId: 'p'.repeat(101), quantity: 1 }], 'each product from the list'],
    [[{ productId: id(1), quantity: 1 }, { productId: id(1), quantity: 2 }], 'listed once'],
    [[{ productId: id(1), quantity: 0 }], 'more than nothing'],
    [[{ productId: id(1), quantity: -3 }], 'more than nothing'],
    [[{ productId: id(1), quantity: 'lots' }], 'more than nothing'],
    [Array.from({ length: 501 }, (_, i) => ({ productId: id(i + 1), quantity: 1 })), 'up to 500'],
  ])('refuses %j in words', (raw, words) => {
    const r = readPar(raw);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(words);
  });
});

describe('arranging the stops', () => {
  const current = [id(1), id(2), id(3)];
  it('takes a new order that names every stop once and no other', () => {
    expect(readOrder([id(3), id(1), id(2)], current)).toEqual({ ok: true, order: [id(3), id(1), id(2)] });
  });
  it('refuses an order that loses, doubles or invents a stop (an out-of-date screen)', () => {
    for (const raw of [[id(1), id(2)], [id(1), id(1), id(2)], [id(1), id(2), id(3), id(4)], [id(1), id(2), id(9)], 'x', [1, 2, 3]]) {
      const r = readOrder(raw, current);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(/changed since you opened it|could not be read/);
    }
  });
  it('moves a stop up or down a place, and says when it cannot', () => {
    expect(movedOrder(current, id(2), -1)).toEqual([id(2), id(1), id(3)]);
    expect(movedOrder(current, id(2), 1)).toEqual([id(1), id(3), id(2)]);
    expect(movedOrder(current, id(1), -1)).toBeNull();
    expect(movedOrder(current, id(3), 1)).toBeNull();
    expect(movedOrder(current, id(9), 1)).toBeNull();
    expect(current).toEqual([id(1), id(2), id(3)]);
  });
});
