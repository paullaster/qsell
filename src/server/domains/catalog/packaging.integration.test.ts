import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { StorefrontCatalog as Catalog } from './storefront-service';
import { has } from '@/lib/values';

/** Packaging relationship persistence and hidden catalogue reads against a migrated test database. */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('checkout packaging catalog (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let StorefrontCatalog: typeof Catalog;
  const token = randomUUID().slice(0, 10).toUpperCase();
  const goodsId = `goods_${token}`;
  const packageId = `pack_${token}`;

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ StorefrontCatalog } = await import('./storefront-service'));
    const itemTypeId = `it_pack_${token}`;
    await db
      .insert(schema.itemTypes)
      .values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await db.insert(schema.products).values([
      {
        id: goodsId,
        sku: `G-${token}`,
        stockCode: `GS-${token}`,
        name: `Goods ${token}`,
        slug: `goods-${token.toLowerCase()}`,
        itemTypeId,
        price: '100',
        costPrice: '50',
        stockQuantity: 25,
      },
      {
        id: packageId,
        sku: `P-${token}`,
        stockCode: `PS-${token}`,
        name: `Bag ${token}`,
        slug: `bag-${token.toLowerCase()}`,
        itemTypeId,
        price: '12',
        costPrice: '3',
        stockQuantity: 30,
        isCheckoutPackaging: true,
      },
    ]);
    await db
      .insert(schema.packagingFits)
      .values({ productId: goodsId, packagingProductId: packageId, capacity: '4' });
  });

  it('loads the seller-configured product fit for cart suggestions but hides packaging from catalogue and direct product reads', async () => {
    const [offer] = await StorefrontCatalog.packagingForProducts([goodsId]);
    expect(offer).toMatchObject({
      productId: goodsId,
      capacity: 4,
      product: { id: packageId, isCheckoutPackaging: true },
    });
    expect(await StorefrontCatalog.productsByIds([packageId])).toEqual([]);
    expect(await StorefrontCatalog.packagingForProducts([])).toEqual([]);
    const { CatalogService } = await import('./service');
    expect(
      await CatalogService.getPublicProductByKey(`bag-${token.toLowerCase()}`),
    ).toBeUndefined();
  });
});
