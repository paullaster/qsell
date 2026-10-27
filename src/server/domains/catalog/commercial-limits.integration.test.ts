import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as CatalogModule from '@/server/domains/catalog/service';
import type { ProductWrite } from '@/types/index';

/**
 * An item's quantity limits and standard price against a real database: both are empty by default, the standard price follows the
 * selling price until it is set, and a limit that makes no sense is refused in words and by the database itself.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('quantity limits and standard price (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let CatalogService: (typeof CatalogModule)['CatalogService'];
  let itemTypeId: string;
  const tag = randomUUID().slice(0, 6).toUpperCase();

  const product = (over: Partial<ProductWrite> = {}): ProductWrite => ({
    sku: `L${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
    stockCode: `LS${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
    name: `Limited ${tag}`,
    slug: `limited-${randomUUID()}`,
    description: '',
    category: '',
    itemTypeId,
    itemTypeName: '',
    itemTypeCode: 0,
    isSellable: true,
    price: 100,
    costPrice: 50,
    stockQuantity: 0,
    lowStockThreshold: 0,
    isActive: true,
    imageUrl: '',
    rating: 0,
    reviewCount: 0,
    tags: [],
    ...over,
  });

  const stored = async (id: string) => (await db.select().from(schema.products).where(eq(schema.products.id, id)))[0];

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ CatalogService } = await import('@/server/domains/catalog/service'));
    itemTypeId = `it_lim_${tag}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  });

  it('are all empty by default, and the standard price is the selling price', async () => {
    const made = await CatalogService.createProduct(product());
    expect(made).toMatchObject({ minOrderQty: null, maxOrderQty: null, standardPrice: null });
    const row = await stored(made.id);
    expect([row?.minOrderQty, row?.maxOrderQty, row?.standardPrice]).toEqual([null, null, null]);
  });

  it('are saved, read back, changed and cleared', async () => {
    const made = await CatalogService.createProduct(product({ minOrderQty: 3, maxOrderQty: 10, standardPrice: 90 }));
    expect(made).toMatchObject({ minOrderQty: 3, maxOrderQty: 10, standardPrice: 90 });
    const read = await CatalogService.getProductById(made.id);
    expect(read).toMatchObject({ minOrderQty: 3, maxOrderQty: 10, standardPrice: 90 });
    await CatalogService.updateProduct(made.id, { minOrderQty: 5 });
    expect(await CatalogService.getProductById(made.id)).toMatchObject({ minOrderQty: 5, maxOrderQty: 10, standardPrice: 90 });
    // Empty clears: back to no limit, and back to following the selling price.
    await CatalogService.updateProduct(made.id, { minOrderQty: null, maxOrderQty: null, standardPrice: null });
    expect(await CatalogService.getProductById(made.id)).toMatchObject({ minOrderQty: null, maxOrderQty: null, standardPrice: null });
    // A save that does not mention them leaves them alone.
    await CatalogService.updateProduct(made.id, { minOrderQty: 2 });
    await CatalogService.updateProduct(made.id, { name: `Renamed ${tag}` });
    expect((await CatalogService.getProductById(made.id))?.minOrderQty).toBe(2);
  });

  it('refuse a pair that makes no sense, in words', async () => {
    await expect(CatalogService.createProduct(product({ minOrderQty: 10, maxOrderQty: 3 }))).rejects.toThrow(/cannot be above the maximum/);
    await expect(CatalogService.createProduct(product({ minOrderQty: 0 }))).rejects.toThrow(/must be above zero/);
    await expect(CatalogService.createProduct(product({ maxOrderQty: -4 }))).rejects.toThrow(/must be above zero/);
    // Counted in the item's own unit: pieces are whole.
    await expect(CatalogService.createProduct(product({ minOrderQty: 2.5 }))).rejects.toThrow(/must be a whole number/);
    const made = await CatalogService.createProduct(product({ minOrderQty: 3 }));
    await expect(CatalogService.updateProduct(made.id, { maxOrderQty: 2 })).rejects.toThrow(/cannot be above the maximum/);
    await expect(CatalogService.updateProduct(made.id, { minOrderQty: 4, maxOrderQty: 4 })).resolves.toBeDefined();
  });

  it('refuse a standard price that makes no sense', async () => {
    await expect(CatalogService.createProduct(product({ standardPrice: -1 }))).rejects.toThrow(/must be 0 or more/);
    await expect(CatalogService.createProduct(product({ standardPrice: 0 }))).rejects.toThrow(/above zero/);
    const made = await CatalogService.createProduct(product());
    await expect(CatalogService.updateProduct(made.id, { standardPrice: -5 })).rejects.toThrow(/must be 0 or more/);
  });

  it('are also held by the database, whatever writes to it', async () => {
    const made = await CatalogService.createProduct(product());
    for (const bad of [{ minOrderQty: 0 }, { maxOrderQty: -1 }, { minOrderQty: 5, maxOrderQty: 2 }, { standardPrice: '-1' }]) {
      await expect(db.update(schema.products).set(bad as never).where(eq(schema.products.id, made.id))).rejects.toThrow();
    }
  });
});
