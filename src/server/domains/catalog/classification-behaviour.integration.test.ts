import { beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import type { drizzleDb as Db } from '@/server/db/drizzle/client';
import type * as Schema from '@/server/db/drizzle/schema';
import type { CatalogService as CatalogServiceType } from './service';
import type { ItemType, ProductWrite } from '@/types/index';
import { has } from '@/lib/values';

const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

/**
 * How a business classification says what its products are (stocked goods, goods that are not stocked, or services), what a new
 * product takes from it, and that a service needs neither a cost nor, when it is not sold from the shop, a selling price.
 */
describe.skipIf(!has(url))('what a classification says its products are (database)', () => {
  let db: typeof Db;
  let schema: typeof Schema;
  let CatalogService: typeof CatalogServiceType;
  const token = randomUUID().slice(0, 8).toUpperCase();
  let n = 0;
  const made: ItemType[] = [];

  const classification = async (over: Partial<Parameters<typeof CatalogServiceType.createItemType>[0]> = {}): Promise<ItemType> => {
    n += 1;
    const type = await CatalogService.createItemType({ name: `Class ${token} ${String(n)}`, code: Math.floor(Math.random() * 1e9), isSellable: true, ...over });
    made.push(type);
    return type;
  };
  const product = (itemTypeId: string, label: string, over: Partial<ProductWrite> = {}): ProductWrite => ({
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

  beforeAll(async () => {
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ CatalogService } = await import('./service'));
  });

  it('keeps how products are managed on the classification, listed with it, and refuses a kind that does not exist', async () => {
    const plain = await classification();
    const services = await classification({ defaultInventoryKind: 'service', isSellable: false });
    expect(plain.defaultInventoryKind).toBe('inventory');
    expect(services.defaultInventoryKind).toBe('service');
    const listed = await CatalogService.getAllItemTypes();
    expect(listed.find((t) => t.id === services.id)?.defaultInventoryKind).toBe('service');
    await expect(classification({ defaultInventoryKind: 'consumable' as never })).rejects.toThrow(/how products of this classification are managed/);
    await expect(CatalogService.updateItemType(plain.id, { defaultInventoryKind: 'consumable' as never })).rejects.toThrow(/how products of this classification are managed/);
    // The database refuses it too, whatever the application does.
    await expect(db.update(schema.itemTypes).set({ defaultInventoryKind: 'consumable' }).where(eq(schema.itemTypes.id, plain.id))).rejects.toThrow();
  });

  it('gives a new product the classification’s behaviour unless the caller says otherwise', async () => {
    const services = await classification({ defaultInventoryKind: 'service', isSellable: false });
    const nonStock = await classification({ defaultInventoryKind: 'non_inventory' });
    expect((await CatalogService.createProduct(product(services.id, 'SVC'))).inventoryKind).toBe('service');
    expect((await CatalogService.createProduct(product(nonStock.id, 'NST'))).inventoryKind).toBe('non_inventory');
    // An explicit choice wins; the classification only supplies the starting point.
    expect((await CatalogService.createProduct(product(services.id, 'EXP', { inventoryKind: 'inventory' }))).inventoryKind).toBe('inventory');
  });

  it('lets a service be made with no cost and no selling price, whether or not its classification is sold from the shop, and keeps it out of sale', async () => {
    const notSold = await classification({ defaultInventoryKind: 'service', isSellable: false });
    const sold = await classification({ defaultInventoryKind: 'service', isSellable: true });
    for (const [label, type] of [['DLV', notSold], ['DLS', sold]] as const) {
      const delivery = await CatalogService.createProduct(product(type.id, label, { price: undefined, costPrice: Number.NaN }));
      expect(delivery, label).toMatchObject({ inventoryKind: 'service', costPrice: 0, isSellable: false });
      expect(delivery.price ?? null, label).toBeNull();
      expect(delivery.stockQuantity, label).toBe(0);
    }
  });

  it('sells a service once it has a price (when its classification is sold), and takes it out of sale again when the price goes', async () => {
    const sold = await classification({ defaultInventoryKind: 'service', isSellable: true });
    const priced = await CatalogService.createProduct(product(sold.id, 'SLP', { costPrice: Number.NaN, price: 1500 }));
    expect(priced).toMatchObject({ inventoryKind: 'service', costPrice: 0, isSellable: true, price: 1500 });
    const free = await CatalogService.createProduct(product(sold.id, 'FRE', { price: undefined }));
    expect(free.isSellable).toBe(false);
    const updated = await CatalogService.updateProduct(free.id, { price: 900 });
    expect(updated).toMatchObject({ isSellable: true, price: 900 });
    // A classification that is not sold from the shop keeps its services out whatever the price.
    const notSold = await classification({ defaultInventoryKind: 'service', isSellable: false });
    expect((await CatalogService.createProduct(product(notSold.id, 'NSP', { price: 700 }))).isSellable).toBe(false);
  });

  it('still asks goods for a cost and for a selling price when their classification is sold', async () => {
    const goods = await classification();
    await expect(CatalogService.createProduct(product(goods.id, 'GDS', { costPrice: Number.NaN }))).rejects.toThrow(/Cost of goods is required/);
    await expect(CatalogService.createProduct(product(goods.id, 'GNP', { price: undefined }))).rejects.toThrow(/Selling price is required/);
  });

  it('does not change products that already exist when the classification changes', async () => {
    const type = await classification();
    const before = await CatalogService.createProduct(product(type.id, 'OLD'));
    await CatalogService.updateItemType(type.id, { defaultInventoryKind: 'service' });
    expect((await CatalogService.getAllItemTypes()).find((t) => t.id === type.id)?.defaultInventoryKind).toBe('service');
    const [row] = await db.select({ kind: schema.products.inventoryKind }).from(schema.products).where(eq(schema.products.id, before.id));
    expect(row?.kind).toBe('inventory');
    expect((await CatalogService.createProduct(product(type.id, 'NEW'))).inventoryKind).toBe('service');
  });
});
