import { describe, expect, it } from 'vitest';
import { keyed } from './keyed';

describe('keyed', () => {
  it('gives repeated names different keys, the same on every call', () => {
    const items = [{ sku: 'A' }, { sku: 'B' }, { sku: 'A' }];
    const first = keyed(items, (i) => i.sku).map((k) => k.key);
    expect(first).toEqual(['A#1', 'B#1', 'A#2']);
    expect(keyed(items, (i) => i.sku).map((k) => k.key)).toEqual(first);
  });
  it('keeps the items in order and handles an empty list', () => {
    expect(keyed([3, 1, 2], String).map((k) => k.item)).toEqual([3, 1, 2]);
    expect(keyed([], String)).toEqual([]);
  });
});
