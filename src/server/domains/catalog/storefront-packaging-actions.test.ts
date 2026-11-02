import { beforeEach, describe, expect, it, vi } from 'vitest';

interface Offer {
  productId: string;
  product: { id: string };
  capacity: number;
}
const packagingForProducts = vi.fn<(ids: string[]) => Promise<Offer[]>>();
vi.mock('./storefront-service', () => ({
  MAX_CART_LOOKUP: 100,
  StorefrontCatalog: { packagingForProducts: (ids: string[]) => packagingForProducts(ids) },
}));

describe('packagingForProductsAction', () => {
  beforeEach(() => packagingForProducts.mockReset());

  it('accepts only bounded, unique product ids and delegates eligibility to the server catalog', async () => {
    packagingForProducts.mockResolvedValue([
      { productId: 'goods-1', product: { id: 'bag-1' }, capacity: 3 },
    ]);
    const { packagingForProductsAction } = await import('./storefront-actions');
    const result = await packagingForProductsAction([
      'goods-1',
      'goods-1',
      '',
      3,
      'x'.repeat(101),
      'goods-2',
    ]);
    expect(packagingForProducts).toHaveBeenCalledWith(['goods-1', 'goods-2']);
    expect(result).toEqual([{ productId: 'goods-1', product: { id: 'bag-1' }, capacity: 3 }]);
  });

  it('returns no options for malformed requests', async () => {
    const { packagingForProductsAction } = await import('./storefront-actions');
    expect(await packagingForProductsAction(null)).toEqual([]);
    expect(await packagingForProductsAction({ productId: 'goods-1' })).toEqual([]);
    expect(packagingForProducts).not.toHaveBeenCalled();
  });
});
