import { describe, expect, it } from 'vitest';
import { suggestPackaging } from './packaging-suggestions';

describe('suggestPackaging', () => {
  it('rounds each eligible item independently using the seller configured capacity', () => {
    expect(suggestPackaging(
      [{ productId: 'omena', quantity: 2.4 }, { productId: 'rice', quantity: 3 }],
      [
        { productId: 'omena', packagingProductId: 'carrier-bag', capacity: 1 },
        { productId: 'rice', packagingProductId: 'carrier-bag', capacity: 2 },
      ],
    )).toEqual([{
      packagingProductId: 'carrier-bag',
      quantity: 5,
      eligibleProductIds: ['omena', 'rice'],
      uncoveredProductIds: [],
    }]);
  });

  it('does not suggest packaging without a configured fit and reports duplicate rules conservatively', () => {
    expect(suggestPackaging(
      [{ productId: 'fish', quantity: 2 }, { productId: 'glass', quantity: 1 }],
      [
        { productId: 'fish', packagingProductId: 'vacuum', capacity: 2 },
        { productId: 'fish', packagingProductId: 'vacuum', capacity: 1 },
      ],
    )).toEqual([{
      packagingProductId: 'vacuum',
      quantity: 2,
      eligibleProductIds: ['fish'],
      uncoveredProductIds: ['glass'],
    }]);
  });

  it('ignores invalid quantities and capacities', () => {
    expect(suggestPackaging(
      [{ productId: 'fish', quantity: Number.NaN }, { productId: 'rice', quantity: 2 }],
      [{ productId: 'fish', packagingProductId: 'bag', capacity: 0 }],
    )).toEqual([]);
  });
});
