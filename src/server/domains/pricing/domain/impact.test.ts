import { describe, expect, it } from 'vitest';
import { estimateImpact, largestPercent, marginPercent } from './impact';

const slice = (over = {}) => ({
  units: 100,
  lines: 40,
  net: 10_000,
  cost: 6_000,
  costedNet: 10_000,
  ...over,
});

describe('what a discount would have cost', () => {
  it('a percentage takes its share of sales and cuts the margin', () => {
    const i = estimateImpact({ type: 'percent', value: 10 }, slice());
    expect(i.giveaway).toBe(1000);
    expect(i.giveawayPercent).toBe(10);
    expect(i.marginBeforePercent).toBe(40);
    // 9,000 of sales against 6,000 of cost.
    expect(i.marginAfterPercent).toBe(33.3);
  });
  it('amounts per unit and per line count units and lines', () => {
    expect(estimateImpact({ type: 'amount_per_unit', value: 5 }, slice()).giveaway).toBe(500);
    expect(estimateImpact({ type: 'amount_per_line', value: 20 }, slice()).giveaway).toBe(800);
  });
  it('an order amount counts the orders that qualified', () => {
    expect(estimateImpact({ type: 'amount', value: 200 }, slice(), { orders: 7 }).giveaway).toBe(
      1400,
    );
  });
  it('a set price gives away the gap to the average price, never negative', () => {
    expect(estimateImpact({ type: 'set_price', value: 80 }, slice()).giveaway).toBe(2000);
    expect(estimateImpact({ type: 'set_price', value: 500 }, slice()).giveaway).toBe(0);
  });
  it('never gives away more than was sold', () => {
    expect(estimateImpact({ type: 'amount_per_unit', value: 5000 }, slice()).giveaway).toBe(10_000);
  });
  it('judges margin only on sales whose cost is known, and says so', () => {
    const i = estimateImpact(
      { type: 'percent', value: 10 },
      slice({ costedNet: 5_000, cost: 3_000 }),
    );
    expect(i.costCoveragePercent).toBe(50);
    expect(i.marginBeforePercent).toBe(40);
    expect(i.notes.join(' ')).toContain('50%');
  });
  it('has no margin when no cost is known, and no estimate when nothing matched', () => {
    const none = estimateImpact({ type: 'percent', value: 10 }, slice({ costedNet: 0, cost: 0 }));
    expect(none.marginBeforePercent).toBeNull();
    const empty = estimateImpact(
      { type: 'percent', value: 10 },
      { units: 0, lines: 0, net: 0, cost: 0, costedNet: 0 },
    );
    expect(empty.giveaway).toBe(0);
    expect(empty.notes.join(' ')).toContain('Nothing in this period matched');
  });
  it('the margin after is never above the margin before', () => {
    for (const v of [1, 5, 10, 25, 50]) {
      const i = estimateImpact({ type: 'percent', value: v }, slice());
      expect(i.marginAfterPercent!).toBeLessThanOrEqual(i.marginBeforePercent!);
    }
  });
  it('finds the largest percentage across steps', () => {
    expect(largestPercent({ type: 'percent', value: 5, tiers: [{ from: 10, value: 8 }] })).toBe(8);
    expect(largestPercent({ type: 'amount', value: 100 })).toBe(0);
  });
  it('margin of a period', () => {
    expect(marginPercent(1000, 700)).toBe(30);
    expect(marginPercent(0, 0)).toBeNull();
  });
});
