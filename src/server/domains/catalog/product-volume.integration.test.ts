import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as CatalogModule from '@/server/domains/catalog/service';
import type { ProductWrite } from '@/types/index';

/**
 * The space one unit of a product takes, in litres, against a real database: empty by default, kept as typed, changed on edit, and
 * refused in words and by the database when it makes no sense.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL ?? '';
if (url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === '')('product volume (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let CatalogService: (typeof CatalogModule)['CatalogService'];
  let itemTypeId: string;
  const tag = randomUUID().slice(0, 6).toUpperCase();

  const product = (over: Partial<ProductWrite> = {}): ProductWrite => ({
    sku: `V${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
    stockCode: `VS${tag}${randomUUID().slice(0, 4)}`.toUpperCase(),
    name: `Volumed ${tag}`,
    slug: `volumed-${randomUUID()}`,
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
    itemTypeId = `it_vol_${tag}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  });

  it('is empty by default, kept as typed, and changed on edit', async () => {
    const plain = await CatalogService.createProduct(product());
    expect((await stored(plain.id))?.volumeLitres).toBeNull();
    const made = await CatalogService.createProduct(product({ volumeLitres: 42.5 }));
    expect(Number((await stored(made.id))?.volumeLitres)).toBe(42.5);
    await CatalogService.updateProduct(made.id, { volumeLitres: 60 });
    expect(Number((await stored(made.id))?.volumeLitres)).toBe(60);
  });

  it('is refused in words when it is nothing, negative or silly, and by the database too', async () => {
    for (const bad of [0, -2, Number.NaN, 2_000_000]) {
      await expect(CatalogService.createProduct(product({ volumeLitres: bad }))).rejects.toThrow(/space one takes/);
    }
    const made = await CatalogService.createProduct(product());
    await expect(CatalogService.updateProduct(made.id, { volumeLitres: -1 })).rejects.toThrow(/space one takes/);
    await expect(db.update(schema.products).set({ volumeLitres: '0' }).where(eq(schema.products.id, made.id))).rejects.toThrow();
  });
});
