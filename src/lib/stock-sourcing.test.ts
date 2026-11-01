import { describe, expect, it } from 'vitest';
import { mergeLines, planSourcing, type AvailabilityGrid, type SourcingCandidate } from './stock-sourcing';

const A: SourcingCandidate = { locationId: 'loc-a', code: 'A' };
const B: SourcingCandidate = { locationId: 'loc-b', code: 'B' };
const grid = (g: Record<string, Record<string, number>>): AvailabilityGrid => new Map(Object.entries(g).map(([loc, p]) => [loc, new Map(Object.entries(p))]));

describe('planSourcing', () => {
  it('takes the whole order from the first location that can cover all of it', () => {
    const plan = planSourcing([{ productId: 'p1', quantity: 2 }, { productId: 'p2', quantity: 1 }], [A, B], grid({ 'loc-a': { p1: 1, p2: 9 }, 'loc-b': { p1: 5, p2: 5 } }));
    expect(plan).toEqual({
      ok: true,
      allocations: [
        { productId: 'p1', locationId: 'loc-b', quantity: 2 },
        { productId: 'p2', locationId: 'loc-b', quantity: 1 },
      ],
      trace: { p1: { rule: 'whole_order_at_one_location', locationCode: 'B' }, p2: { rule: 'whole_order_at_one_location', locationCode: 'B' } },
    });
  });

  it('prefers the earlier location when both can cover everything', () => {
    const plan = planSourcing([{ productId: 'p1', quantity: 1 }], [A, B], grid({ 'loc-a': { p1: 1 }, 'loc-b': { p1: 10 } }));
    expect(plan.ok && plan.allocations[0]?.locationId).toBe('loc-a');
  });

  it('splits an order over locations only when no one location can cover it, line by line', () => {
    const plan = planSourcing([{ productId: 'p1', quantity: 3 }, { productId: 'p2', quantity: 3 }], [A, B], grid({ 'loc-a': { p1: 5, p2: 0 }, 'loc-b': { p1: 0, p2: 5 } }));
    expect(plan).toMatchObject({
      ok: true,
      allocations: [
        { productId: 'p1', locationId: 'loc-a', quantity: 3 },
        { productId: 'p2', locationId: 'loc-b', quantity: 3 },
      ],
      trace: { p1: { rule: 'line_at_one_location', locationCode: 'A' }, p2: { rule: 'line_at_one_location', locationCode: 'B' } },
    });
  });

  it('splits a single line over locations when none holds enough alone', () => {
    const plan = planSourcing([{ productId: 'p1', quantity: 7 }], [A, B], grid({ 'loc-a': { p1: 4 }, 'loc-b': { p1: 5 } }));
    expect(plan).toMatchObject({
      ok: true,
      allocations: [
        { productId: 'p1', locationId: 'loc-a', quantity: 4 },
        { productId: 'p1', locationId: 'loc-b', quantity: 3 },
      ],
      trace: { p1: { rule: 'line_split_across_locations' } },
    });
  });

  it('names the line that is short, with what all locations together can give', () => {
    const plan = planSourcing([{ productId: 'p1', quantity: 10 }], [A, B], grid({ 'loc-a': { p1: 4 }, 'loc-b': { p1: 5 } }));
    expect(plan).toEqual({ ok: false, productId: 'p1', available: 9, requested: 10 });
  });

  it('fails with no candidates at all, and plans nothing for an empty order', () => {
    expect(planSourcing([{ productId: 'p1', quantity: 1 }], [], grid({}))).toEqual({ ok: false, productId: 'p1', available: 0, requested: 1 });
    expect(planSourcing([], [A], grid({}))).toEqual({ ok: true, allocations: [], trace: {} });
  });

  it('does not promise the same stock to two lines', () => {
    const plan = planSourcing([{ productId: 'p1', quantity: 3 }, { productId: 'p1', quantity: 3 }], [A], grid({ 'loc-a': { p1: 5 } }));
    expect(plan.ok).toBe(false);
  });

  it('keeps fractions exact', () => {
    const plan = planSourcing([{ productId: 'p1', quantity: 0.3 }], [A], grid({ 'loc-a': { p1: 0.1 + 0.2 } }));
    expect(plan.ok).toBe(true);
  });
});

describe('mergeLines', () => {
  it('adds a product’s lines together and orders them by product', () => {
    expect(mergeLines([{ productId: 'b', quantity: 1 }, { productId: 'a', quantity: 0.1 }, { productId: 'a', quantity: 0.2 }])).toEqual([
      { productId: 'a', quantity: 0.3 },
      { productId: 'b', quantity: 1 },
    ]);
  });
});
