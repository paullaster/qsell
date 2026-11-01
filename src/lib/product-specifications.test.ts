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
