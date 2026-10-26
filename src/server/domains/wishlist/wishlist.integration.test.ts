import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { has } from '@/lib/values';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as SchemaModule from '@/server/db/drizzle/schema';
import type { WishlistService as Service } from './service';

/** Saved products against a real database.   TEST_DATABASE_URL=postgres://... pnpm test */
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!has(url))('wishlist (database)', () => {
  let db: typeof drizzleDb;
  let schema: typeof SchemaModule;
  let service: typeof Service;
  let itemTypeId: string;
  const tag = randomUUID().slice(0, 6);

  const product = async (over: Record<string, unknown> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `WL-${randomUUID().slice(0, 6)}`.toUpperCase(), stockCode: `WS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `${tag} item`, slug: `wl-${randomUUID()}`, itemTypeId, price: '10', taxRate: '0', isTaxInclusive: true, stockQuantity: 5, ...over });
    return id;
  };

  beforeAll(async () => {
    process.env.DATABASE_URL = url;
    ({ drizzleDb: db } = await import('@/server/db/drizzle/client'));
    schema = await import('@/server/db/drizzle/schema');
    ({ WishlistService: service } = await import('./service'));
    itemTypeId = `it_wl_${tag}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
  });

  it('saves and removes a product, newest first, once, and keeps one person\'s list from another\'s', async () => {
    const [a, b] = [await product(), await product()];
    const me = `u-${tag}-1`;
    const other = `u-${tag}-2`;
    await service.set(me, a, true);
    await service.set(me, b, true);
    await service.set(me, b, true); // saving twice is one
    await service.set(other, a, true);
    expect(await service.ids(me)).toEqual([b, a]);
    expect(await service.ids(other)).toEqual([a]);
    await service.set(me, a, false);
    expect(await service.ids(me)).toEqual([b]);
    expect(await service.ids(other)).toEqual([a]);
  });

  it('does not save a product that is not for sale or does not exist', async () => {
    const live = await product();
    const off = await product({ isActive: false });
    const notSold = await product({ isSellable: false });
    const gone = await product({ deletedAt: new Date() });
    const me = `u-${tag}-3`;
    for (const id of [off, notSold, gone, 'prod_missing']) await service.set(me, id, true);
    await service.set(me, live, true);
    expect(await service.ids(me)).toEqual([live]);
  });

  it('merges what a guest saved with the account list, skipping what is not for sale, with no repeats', async () => {
    const [a, b, off] = [await product(), await product(), await product({ isActive: false })];
    const me = `u-${tag}-4`;
    await service.set(me, a, true);
    const merged = await service.merge(me, [b, a, off, 'prod_missing', b]);
    expect([...merged].sort()).toEqual([a, b].sort());
    expect(await service.merge(me, [])).toHaveLength(2);
  });

  it('forgets a product when it is deleted for good', async () => {
    const a = await product();
    const me = `u-${tag}-5`;
    await service.set(me, a, true);
    await db.delete(schema.products).where(eq(schema.products.id, a));
    expect(await service.ids(me)).toEqual([]);
  });
});
