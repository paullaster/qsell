import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { CatalogService as CatalogServiceType } from './service';
import type { ItemType, Product, ProductWrite } from '@/types/index';
import { has } from '@/lib/values';

const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

/**
 * A business classification's "sold to customers" answer, name and code reach the products that use it, in the same transaction, whichever
 * way the classification is edited; a product's own save follows the classification as it is now; and the web shop shows only what is
 * both sold and shown.
 */
describe.skipIf(!has(url))('classification and its products stay in step (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let CatalogService: typeof CatalogServiceType;
  const token = randomUUID().slice(0, 8).toUpperCase();
  let n = 0;

  const classification = async (over: Partial<Parameters<typeof CatalogServiceType.createItemType>[0]> = {}): Promise<ItemType> => {
    n += 1;
    return await CatalogService.createItemType({ name: `Cascade ${token} ${String(n)}`, code: Math.floor(Math.random() * 1e9), isSellable: true, ...over });
  };
  const write = (itemTypeId: string, label: string, over: Partial<ProductWrite> = {}): ProductWrite => ({
    sku: `${token}-${label}`,
    stockCode: `${token}-S-${label}`,
    name: `${label} ${token}`,
    slug: `${label.toLowerCase()}-${token.toLowerCase()}`,
    description: '',
    category: '',
    itemTypeId,
    itemTypeName: '',
    itemTypeCode: 1,
    isSellable: true,
    price: 20,
    costPrice: 5,
    stockQuantity: 0,
    lowStockThreshold: 0,
    isActive: true,
    imageUrl: '',
    rating: 0,
    reviewCount: 0,
    tags: [],
    ...over,
  });
  const make = async (itemTypeId: string, label: string, over: Partial<ProductWrite> = {}): Promise<Product> => await CatalogService.createProduct(write(itemTypeId, label, over));
  const stored = async (id: string) => {
    const [row] = await db.select().from(schema.products).where(eq(schema.products.id, id));
    if (row === undefined) throw new Error('the product is gone');
    return row;
  };
  const turn = async (type: ItemType, isSellable: boolean) => await CatalogService.updateItemType(type.id, { isSellable });

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ CatalogService } = await import('./service'));
  });

  it('turning a classification off stops its products being sold, in the same save, and turning it on starts the ones with a price', async () => {
    const type = await classification();
    const priced = await make(type.id, 'P1');
    const service = await make(type.id, 'SV1', { inventoryKind: 'service', price: 100 });
    expect((await stored(priced.id)).isSellable).toBe(true);
    await turn(type, false);
    expect((await stored(priced.id)).isSellable).toBe(false);
    expect((await stored(service.id)).isSellable).toBe(false);
    await turn(type, true);
    expect((await stored(priced.id)).isSellable).toBe(true);
    expect((await stored(service.id)).isSellable).toBe(true);
  });

  it('turning on does not sell a product that has no selling price', async () => {
    const type = await classification({ isSellable: false });
    const free = await make(type.id, 'NP1', { price: undefined });
    const priced = await make(type.id, 'NP2', { price: 15 });
    await turn(type, true);
    expect((await stored(free.id)).isSellable).toBe(false);
    expect((await stored(priced.id)).isSellable).toBe(true);
  });

  it('turning on or off leaves other classifications, and the products\' own shop choice, alone', async () => {
    const a = await classification();
    const b = await classification();
    const inA = await make(a.id, 'A1');
    const inB = await make(b.id, 'B1');
    await CatalogService.updateProduct(inA.id, { showOnWebShop: false });
    await turn(a, false);
    await turn(a, true);
    expect((await stored(inB.id)).isSellable).toBe(true);
    expect((await stored(inA.id)).showOnWebShop).toBe(false);
  });

  it('a rename or a new code is what the products show at once (they read it from the classification)', async () => {
    const type = await classification();
    const product = await make(type.id, 'R1');
    await CatalogService.updateItemType(type.id, { name: `Renamed ${token}`, code: 900_000_000 + Math.floor(Math.random() * 90_000_000) });
    const read = await CatalogService.getProductById(product.id);
    expect(read?.itemTypeName).toBe(`Renamed ${token}`);
    expect(read?.itemTypeCode).toBeGreaterThanOrEqual(900_000_000);
  });

  it('the database does it too, whichever way the classification is edited', async () => {
    const type = await classification();
    const product = await make(type.id, 'D1');
    await db.update(schema.itemTypes).set({ isSellable: false }).where(eq(schema.itemTypes.id, type.id));
    expect((await stored(product.id)).isSellable).toBe(false);
  });

  it('refuses to stop selling a classification whose products are offered as checkout packaging, and changes nothing', async () => {
    const type = await classification();
    const box = await make(type.id, 'PK1', { isCheckoutPackaging: true });
    const other = await make(type.id, 'PK2');
    await expect(turn(type, false)).rejects.toThrow(/offered as checkout packaging/);
    expect((await stored(box.id)).isSellable).toBe(true);
    expect((await stored(other.id)).isSellable).toBe(true);
    expect((await CatalogService.getItemTypeById(type.id))?.isSellable).toBe(true);
    // The database refuses it by itself too.
    await expect(db.update(schema.itemTypes).set({ isSellable: false }).where(eq(schema.itemTypes.id, type.id))).rejects.toThrow();
  });

  it('says what a change would do before it is made', async () => {
    const type = await classification();
    await make(type.id, 'I1');
    await make(type.id, 'I2');
    await make(type.id, 'I3', { isCheckoutPackaging: true });
    expect(await CatalogService.itemTypeChange(type.id, true)).toMatchObject({ effect: 'none' });
    const stop = await CatalogService.itemTypeChange(type.id, false);
    expect(stop?.blocked).toContain('1 product of this classification is offered as checkout packaging');
    expect(stop?.affected).toBe(3);
    expect(await CatalogService.itemTypeChange('missing', false)).toBeUndefined();
    const closed = await classification({ isSellable: false });
    await make(closed.id, 'I4', { price: 9 });
    await make(closed.id, 'I5', { price: undefined });
    expect(await CatalogService.itemTypeChange(closed.id, true)).toMatchObject({ effect: 'start', affected: 1, needPrice: 1 });
  });

  it('a product saved after its classification changed follows the classification, not the copy it held', async () => {
    const type = await classification();
    const product = await make(type.id, 'F1');
    // Simulate a product left behind (as every product was before the database kept them in step).
    await db.execute(sql`ALTER TABLE item_types DISABLE TRIGGER item_types_cascade_trg`);
    try {
      await db.update(schema.itemTypes).set({ isSellable: false }).where(eq(schema.itemTypes.id, type.id));
    } finally {
      await db.execute(sql`ALTER TABLE item_types ENABLE TRIGGER item_types_cascade_trg`);
    }
    expect((await stored(product.id)).isSellable).toBe(true);
    await CatalogService.updateProduct(product.id, { description: 'edited' });
    expect((await stored(product.id)).isSellable).toBe(false);
  });

  it('never takes the "sold" answer from what the browser sends', async () => {
    const type = await classification({ isSellable: false });
    const product = await make(type.id, 'N1', { price: 10 });
    await CatalogService.updateProduct(product.id, { isSellable: true, description: 'x' });
    expect((await stored(product.id)).isSellable).toBe(false);
  });

  it('refuses a name or code another classification already has, in plain words', async () => {
    const one = await classification();
    const two = await classification();
    await expect(CatalogService.updateItemType(two.id, { name: one.name })).rejects.toThrow('Another business classification already has that name.');
    await expect(CatalogService.updateItemType(two.id, { code: one.code })).rejects.toThrow('Another business classification already has that tax authority code.');
    await expect(CatalogService.updateItemType(two.id, { name: '  ' })).rejects.toThrow('Give the business classification a name.');
  });

  it('the web shop shows only what is sold and shown; staff and quotes still see a product kept off the shop', async () => {
    const type = await classification();
    const shown = await make(type.id, 'W1');
    const hidden = await make(type.id, 'W2', { showOnWebShop: false });
    const shop = await CatalogService.getSellableProducts();
    expect(shop.map((p) => p.id)).toContain(shown.id);
    expect(shop.map((p) => p.id)).toContain(hidden.id); // the staff list of sellable products is not the shop's
    expect(await CatalogService.getPublicProduct(shown.id)).toBeDefined();
    expect(await CatalogService.getPublicProduct(hidden.id)).toBeUndefined();
    const { StorefrontCatalog } = await import('./storefront-service');
    const found = await StorefrontCatalog.productsByIds([shown.id, hidden.id]);
    expect(found.map((p) => p.id)).toEqual([shown.id]);
    // And the product is still sold: it is the shop that does not show it.
    expect((await stored(hidden.id)).isSellable).toBe(true);
  });
});
