import { describe, expect, it } from 'vitest';
import {
  MAX_PRODUCT_SPECIFICATIONS,
  PRODUCT_SPECIFICATION_KEY_MAX_LENGTH,
  PRODUCT_SPECIFICATION_VALUE_MAX_LENGTH,
  productSpecificationsProblem,
  visibleSpecifications,
} from './product-specifications';

describe('specifications shown to shoppers', () => {
  it('keeps rows with a name and a value, trimmed, in order', () => {
    expect(
      visibleSpecifications([
        { key: ' Colour ', value: ' Red ' },
        { key: 'Weight', value: '2 kg' },
      ]),
    ).toEqual([
      { key: 'Colour', value: 'Red' },
      { key: 'Weight', value: '2 kg' },
    ]);
  });

  it('drops half-filled rows, and copes with none', () => {
    expect(
      visibleSpecifications([
        { key: 'Colour', value: ' ' },
        { key: '', value: 'x' },
      ]),
    ).toEqual([]);
    expect(visibleSpecifications(undefined)).toEqual([]);
  });
});

describe('product specification editing rules', () => {
  it('accepts and trims edited names and values', () => {
    expect(productSpecificationsProblem([{ key: ' Power ', value: ' 620 W ' }])).toBeNull();
    expect(visibleSpecifications([{ key: ' Power ', value: ' 620 W ' }])).toEqual([
      { key: 'Power', value: '620 W' },
    ]);
  });

  it('rejects half-filled, malformed and oversized specification lists', () => {
    expect(productSpecificationsProblem([{ key: 'Colour', value: ' ' }])).toMatch(/name and value/);
    expect(productSpecificationsProblem([{ key: 5, value: 'red' }])).toMatch(/not valid/);
    expect(
      productSpecificationsProblem(
        Array.from({ length: MAX_PRODUCT_SPECIFICATIONS + 1 }, () => ({ key: 'A', value: 'B' })),
      ),
    ).toMatch(/at most/);
    expect(
      productSpecificationsProblem([
        { key: 'x'.repeat(PRODUCT_SPECIFICATION_KEY_MAX_LENGTH + 1), value: 'v' },
      ]),
    ).toMatch(/name must be/);
    expect(
      productSpecificationsProblem([
        { key: 'k', value: 'x'.repeat(PRODUCT_SPECIFICATION_VALUE_MAX_LENGTH + 1) },
      ]),
    ).toMatch(/value must be/);
  });
});

describe('moveSpecification', () => {
  const rows = ['a', 'b', 'c', 'd'];
  it('moves a row up, down and to either end, leaving the others in order', async () => {
    const { moveSpecification } = await import('./product-specifications');
    expect(moveSpecification(rows, 3, 2)).toEqual(['a', 'b', 'd', 'c']);
    expect(moveSpecification(rows, 0, 1)).toEqual(['b', 'a', 'c', 'd']);
    expect(moveSpecification(rows, 0, 3)).toEqual(['b', 'c', 'd', 'a']);
    expect(moveSpecification(rows, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });
  it('never changes the list it was given, and ignores moves that go nowhere or off the list', async () => {
    const { moveSpecification } = await import('./product-specifications');
    const before = [...rows];
    moveSpecification(rows, 0, 3);
    expect(rows).toEqual(before);
    for (const [from, to] of [[1, 1], [-1, 2], [2, -1], [4, 0], [0, 4], [1.5, 2], [Number.NaN, 0]]) {
      expect(moveSpecification(rows, from, to)).toEqual(rows);
    }
    expect(moveSpecification([], 0, 1)).toEqual([]);
  });
  it('keeps the order the shop shows after the server tidies the rows', async () => {
    const { visibleSpecifications, moveSpecification } = await import('./product-specifications');
    const ordered = moveSpecification([{ key: ' RAM ', value: '16GB' }, { key: 'Colour', value: 'Black' }, { key: 'Empty', value: '  ' }, { key: 'Weight', value: '2kg' }], 3, 0);
    expect(visibleSpecifications(ordered).map((s) => s.key)).toEqual(['Weight', 'RAM', 'Colour']);
  });
});
