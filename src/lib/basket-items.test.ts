import { describe, expect, it } from 'vitest';
import { readBasketItem, readBasketItems } from './basket-items';

describe('reading basket lines from the browser', () => {
  it('reads a plain line and drops anything else it says, such as a price', () => {
    expect(readBasketItem({ productId: 'p', quantity: 2, price: 1 })).toEqual({ productId: 'p', quantity: 2 });
  });
  it('reads a package line with its choices, as ids and counts only', () => {
    expect(readBasketItem({ productId: 'p', quantity: 3, package: { picks: [{ slotId: 's', optionId: 'o', count: 1, price: 5 }] } })).toEqual({ productId: 'p', quantity: 3, package: { picks: [{ slotId: 's', optionId: 'o', count: 1 }] } });
  });
  it('refuses lines that cannot be read', () => {
    for (const bad of [null, 'x', {}, { productId: '', quantity: 1 }, { productId: 'p', quantity: 0 }, { productId: 'p', quantity: Number.NaN }, { productId: 'p', quantity: 2_000_000 }, { productId: 'p', quantity: 1.5, package: { picks: [] } }, { productId: 'p', quantity: 1, package: 'x' }, { productId: 'p', quantity: 1, package: { picks: [{ slotId: 's' }] } }, { productId: 'p', quantity: 1, package: { picks: [{ slotId: 's', optionId: 'o', count: 'x' }] } }]) {
      expect(readBasketItem(bad)).toBeNull();
    }
  });
  it('reads a list, refusing it whole when one line is bad, and clips the length', () => {
    expect(readBasketItems([{ productId: 'a', quantity: 1 }, { productId: 'b', quantity: 2 }])).toHaveLength(2);
    expect(readBasketItems([{ productId: 'a', quantity: 1 }, null])).toBeNull();
    expect(readBasketItems('nope')).toBeNull();
    expect(readBasketItems(Array.from({ length: 150 }, () => ({ productId: 'a', quantity: 1 })), 100)).toHaveLength(100);
  });
  it('reads the group a package line came from only when it is an id', () => {
    const group = '3f2a9c1e-5b7d-4e0a-9c11-0a1b2c3d4e5f';
    const line = (groupId: unknown) => readBasketItem({ productId: 'p', quantity: 2, package: { picks: [{ slotId: 's', optionId: 'o', count: 1 }], groupId } });
    expect(line(group)?.package?.groupId).toBe(group);
    expect(line('x')?.package?.groupId).toBeUndefined();
    expect(line(5)?.package?.groupId).toBeUndefined();
    expect(line(undefined)?.package).toEqual({ picks: [{ slotId: 's', optionId: 'o', count: 1 }] });
  });
});
