import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AccessDeniedError } from '@/server/domains/access-control/engine';

const requirePermission = vi.fn();
const canPermission = vi.fn();
const getProductAction = vi.fn();

vi.mock('@/server/domains/access-control/guard', () => ({
  requirePermission: (...args: unknown[]) => requirePermission(...args) as unknown,
  canPermission: (...args: unknown[]) => canPermission(...args) as unknown,
}));
vi.mock('@/server/domains/catalog/actions', () => ({
  listProductsAction: vi.fn(),
  getProductAction: (...args: unknown[]) => getProductAction(...args) as unknown,
}));
vi.mock('@/server/domains/customers/master-actions', () => ({ listTradeCustomersAction: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/server/di/container', () => ({ getContainer: vi.fn() }));

const actions = await import('./actions');
const ID = 'prod_3f0c6a52-5b1e-4f0e-9a52-0d2d6a4b9c11';

beforeEach(() => {
  requirePermission.mockReset().mockResolvedValue('user-1');
  canPermission.mockReset().mockResolvedValue(false);
  getProductAction.mockReset();
});

describe('the product shortcut on the quote screens', () => {
  it('offers it only when the server says the person may update products', async () => {
    canPermission.mockImplementation((key: string) => Promise.resolve(key === 'products:update'));
    expect((await actions.getSalesQuoteCapabilitiesAction()).canEditProducts).toBe(true);
    canPermission.mockResolvedValue(false);
    expect((await actions.getSalesQuoteCapabilitiesAction()).canEditProducts).toBe(false);
    expect(canPermission).toHaveBeenCalledWith('products:update');
  });

  it('reads a product again as the slim catalogue shape, without descriptions or media', async () => {
    getProductAction.mockResolvedValue({ id: ID, sku: 'S1', stockCode: 'C1', name: 'Pump', category: 'Tools', brand: 'B', isSellable: true, price: 12, costPrice: 7, taxRate: 16, isTaxInclusive: false, stockQuantity: 5, reservedQuantity: 1, imageUrl: '/i.jpg', baseUnitId: 'u', baseUnitCode: 'pc', baseUnitName: 'Piece', description: 'long text', media: [{ assetId: 'a' }], specifications: [{ key: 'k', value: 'v' }] });
    const out = await actions.getQuoteCatalogueProductAction(ID);
    expect(requirePermission).toHaveBeenCalledWith('quotes:read');
    expect(out).toMatchObject({ id: ID, name: 'Pump', price: 12 });
    expect(out).not.toHaveProperty('description');
    expect(out).not.toHaveProperty('media');
    expect(out).not.toHaveProperty('specifications');
  });

  it('answers no product for a bad id or a product that is gone, without looking it up for a bad id', async () => {
    expect(await actions.getQuoteCatalogueProductAction('not an id; drop')).toBeNull();
    expect(await actions.getQuoteCatalogueProductAction({ id: ID })).toBeNull();
    expect(getProductAction).not.toHaveBeenCalled();
    getProductAction.mockResolvedValue(null);
    expect(await actions.getQuoteCatalogueProductAction(ID)).toBeNull();
  });

  it('refuses a person who cannot read quotes', async () => {
    requirePermission.mockRejectedValue(new AccessDeniedError('quotes:read', { allowed: false, reason: 'deny-grant' }));
    await expect(actions.getQuoteCatalogueProductAction(ID)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(getProductAction).not.toHaveBeenCalled();
  });
});
