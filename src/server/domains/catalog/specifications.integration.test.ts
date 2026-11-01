import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type * as CatalogModule from '@/server/domains/catalog/service';
import type { ProductWrite } from '@/types/index';
import { has } from '@/lib/values';

/** Product specifications are saved and read back by the catalogue against a migrated test database. */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('product specifications (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let CatalogService: (typeof CatalogModule)['CatalogService'];
  let itemTypeId: string;
  const tag = randomUUID().slice(0, 8);

  const product = (): ProductWrite => ({
    sku: `SPEC-${tag}`.toUpperCase(),
    stockCode: `SPECS-${tag}`.toUpperCase(),
    name: `Specification test ${tag}`,
    slug: `specification-test-${tag}`,
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
    specifications: [{ key: 'Power', value: '500 W' }],
  });

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ CatalogService } = await import('@/server/domains/catalog/service'));
    itemTypeId = `it_spec_${tag}`;
    await db.insert(schema.itemTypes).values({
      id: itemTypeId,
      code: Math.floor(Math.random() * 1e9),
      name: itemTypeId,
    });
  });

  it('creates, edits, adds and removes existing specification rows', async () => {
    const created = await CatalogService.createProduct(product());
    expect(created.specifications).toEqual([{ key: 'Power', value: '500 W' }]);

    const changed = [
      { key: 'Power output', value: '620 W' },
      { key: 'Warranty', value: '15 years' },
    ];
    await CatalogService.updateProduct(created.id, { specifications: changed });
    expect((await CatalogService.getProductById(created.id))?.specifications).toEqual(changed);

    await expect(
      CatalogService.updateProduct(created.id, {
        specifications: [{ key: 'Incomplete', value: ' ' }],
      }),
    ).rejects.toThrow(/Enter both a name and value/);
    expect((await CatalogService.getProductById(created.id))?.specifications).toEqual(changed);

    const stored = (
      await db
        .select({ specifications: schema.products.specifications })
        .from(schema.products)
        .where(eq(schema.products.id, created.id))
    )[0];
    expect(stored?.specifications).toEqual(changed);

    await CatalogService.updateProduct(created.id, {
      specifications: [{ key: 'Warranty', value: '20 years' }],
    });
    expect((await CatalogService.getProductById(created.id))?.specifications).toEqual([
      { key: 'Warranty', value: '20 years' },
    ]);
  });
});
