import { describe, expect, it } from 'vitest';
import { kitsBuildable } from './shop-availability';

const kit = { components: [{ productId: 'a', quantity: 2 }, { productId: 'b', quantity: 1 }] } as never;
const part = (stock: number, reserved = 0, managed = true) => ({ stock, reserved, managed });

describe('how many of a kit the shop can offer', () => {
  it('is set by the scarcest part', () => {
    expect(kitsBuildable(kit, new Map([['a', part(9)], ['b', part(10)]]))).toBe(4);
  });
  it('does not count what is promised to others', () => {
    expect(kitsBuildable(kit, new Map([['a', part(9, 5)], ['b', part(10)]]))).toBe(2);
  });
  it('is zero when a part has run out or is missing', () => {
    expect(kitsBuildable(kit, new Map([['a', part(1)], ['b', part(10)]]))).toBe(0);
    expect(kitsBuildable(kit, new Map([['a', part(9)]]))).toBe(0);
    expect(kitsBuildable(kit, new Map([['a', part(9, 20)], ['b', part(10)]]))).toBe(0);
  });
  it('ignores a part that is not counted, and is unlimited when none is', () => {
    expect(kitsBuildable(kit, new Map([['a', part(9)], ['b', part(0, 0, false)]]))).toBe(4);
    expect(kitsBuildable(kit, new Map([['a', part(0, 0, false)], ['b', part(0, 0, false)]]))).toBe(Number.POSITIVE_INFINITY);
  });
});
