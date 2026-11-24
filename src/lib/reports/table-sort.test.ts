import { describe, expect, it } from 'vitest';
import { nextSort, sortRows } from './table-sort';

const rows = [
  { id: 'a', v: 10 as number | string | null },
  { id: 'b', v: 2 },
  { id: 'c', v: null },
  { id: 'd', v: 10 },
  { id: 'e', v: 30 },
];

describe('sortRows', () => {
  it('sorts numbers as numbers, with empty cells last either way', () => {
    expect(sortRows(rows, (r) => r.v, 'asc').map((r) => r.id)).toEqual(['b', 'a', 'd', 'e', 'c']);
    expect(sortRows(rows, (r) => r.v, 'desc').map((r) => r.id)).toEqual(['e', 'a', 'd', 'b', 'c']);
  });

  it('keeps equal rows in their original order, both ways', () => {
    expect(
      sortRows(rows, (r) => r.v, 'asc')
        .filter((r) => r.v === 10)
        .map((r) => r.id),
    ).toEqual(['a', 'd']);
    expect(
      sortRows(rows, (r) => r.v, 'desc')
        .filter((r) => r.v === 10)
        .map((r) => r.id),
    ).toEqual(['a', 'd']);
  });

  it('sorts text with numbers inside it in numeric order and ignores case', () => {
    const shops = ['Shop 10', 'shop 2', 'Shop 1'].map((v, i) => ({ id: String(i), v }));
    expect(sortRows(shops, (r) => r.v, 'asc').map((r) => r.v)).toEqual([
      'Shop 1',
      'shop 2',
      'Shop 10',
    ]);
  });

  it('treats an empty string as empty and does not change the input', () => {
    const input = [{ v: 'b' }, { v: '' }, { v: 'a' }];
    const copy = [...input];
    expect(sortRows(input, (r) => r.v, 'asc').map((r) => r.v)).toEqual(['a', 'b', '']);
    expect(input).toEqual(copy);
  });

  it('handles nothing and one row', () => {
    expect(sortRows([], () => 1, 'asc')).toEqual([]);
    expect(sortRows([{ v: 1 }], (r) => r.v, 'desc')).toEqual([{ v: 1 }]);
  });
});

describe('nextSort', () => {
  it('cycles ascending, descending, none, and starts again on another column', () => {
    const a = nextSort(null, 2);
    expect(a).toEqual({ column: 2, direction: 'asc' });
    const b = nextSort(a, 2);
    expect(b).toEqual({ column: 2, direction: 'desc' });
    expect(nextSort(b, 2)).toBeNull();
    expect(nextSort(b, 3)).toEqual({ column: 3, direction: 'asc' });
  });
});
