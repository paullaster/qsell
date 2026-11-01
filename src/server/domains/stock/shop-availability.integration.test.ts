import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inArray } from 'drizzle-orm';
import { has } from '@/lib/values';
import { DEFAULT_STOREFRONT_QUERY, type StorefrontQuery } from '@/lib/storefront-search';
import { availableOf } from '@/lib/cart-quantity';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { StorefrontCatalog as Catalog } from '@/server/domains/catalog/storefront-service';
import type * as AvailabilityModule from '@/server/domains/catalog/shop-availability';
import { settleFinanceBacklog } from './test-support';

/**
 * What the web shop shows of a product's stock, against a real database: while the per-location ledger is the truth, only the stock
 * of the places that sell to the web shop counts, and what is shown is what checkout will accept.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('what the shop shows of the stock (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let Storefront: typeof Catalog;
  let availability: typeof AvailabilityModule;
  let companyId: string;
  let itemTypeId: string;
  let main: string;
  let quarantine: string;
  let backOffice: string;
  const run = randomUUID().slice(0, 8);
  const tag = `zs${run}`;
  const made: string[] = [];

  const product = async (name: string, counters = 0) => {
    const id = `prod_sa_${randomUUID()}`;
    made.push(id);
    await db.insert(schema.products).values({ id, sku: `${tag}-${randomUUID().slice(0, 6)}`.toUpperCase(), stockCode: `SAS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `${tag} ${name}`, slug: `${tag}-${randomUUID()}`, itemTypeId, price: '100', taxRate: '0', isTaxInclusive: true, stockQuantity: counters });
    return id;
  };
  const put = (productId: string, quantity: number, locationId: string) => db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId, type: 'receipt', quantity, unitCost: 10, actor: { type: 'job' } }));
  const search = (over: Partial<StorefrontQuery> = {}) => Storefront.search({ ...DEFAULT_STOREFRONT_QUERY, q: tag, ...over });
  const names = (page: { products: { name: string }[] }) => page.products.map((p) => p.name.replace(`${tag} `, ''));
  const asLedger = async (on: boolean) => {
    if (on) await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    else await c.stockSettings.setLedgerMode(companyId, false);
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ StorefrontCatalog: Storefront } = await import('@/server/domains/catalog/storefront-service'));
    availability = await import('@/server/domains/catalog/shop-availability');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    itemTypeId = `it_sa_${run}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    main = (await c.stockLocations.ensureDefault(companyId)).id;
    quarantine = (await c.stockLocations.create(companyId, { code: `SQ${run}`.toUpperCase(), name: 'Inspection', kind: 'quarantine', isSellable: false })).id;
    backOffice = (await c.stockLocations.create(companyId, { code: `SB${run}`.toUpperCase(), name: 'Orders only', kind: 'warehouse', sellsChannels: ['sales_order'] })).id;
    await c.stockShadow.setShadow(companyId, false);
    await asLedger(false);
  });
  afterAll(async () => {
    await asLedger(false);
    if (made.length > 0) await db.delete(schema.products).where(inArray(schema.products.id, made));
    await settleFinanceBacklog(c.finance);
  }, 120_000);

  it('leaves the product’s own counters alone while the ledger is not the truth', async () => {
    const id = await product('Counters', 9);
    const page = await search();
    expect(page.products.find((p) => p.id === id)).toMatchObject({ stockQuantity: 9 });
    expect(names(await search({ inStock: true }))).toContain('Counters');
    const same = await availability.withShopAvailability(page.products);
    expect(same).toBe(page.products);
  });

  describe('with the ledger as the truth', () => {
    beforeAll(async () => {
      await asLedger(true);
    });
    afterAll(async () => {
      await asLedger(false);
    });

    it('counts only the places that sell to the web shop: not a quarantine, not a place for sales orders only', async () => {
      const id = await product('Mixed');
      await put(id, 10, main);
      await put(id, 5, quarantine);
      await put(id, 7, backOffice);
      const found = (await search()).products.find((p) => p.id === id);
      expect(found).toMatchObject({ stockQuantity: 10, reservedQuantity: 0 });
      expect(availableOf(found ?? { stockQuantity: 0, reservedQuantity: 0 })).toBe(10);
      const [row] = await db.select({ s: schema.products.stockQuantity }).from(schema.products).where(inArray(schema.products.id, [id]));
      expect(row?.s).toBe(22);
    });

    it('subtracts what is promised, and shows what checkout will accept: that much works, one more does not', async () => {
      const id = await product('Promised');
      await put(id, 6, main);
      const held = await c.stockReservations.reserve({ companyId, refType: 'order', refId: `ord_${randomUUID()}`, lines: [{ productId: id, quantity: 2 }], channel: 'ecommerce', actor: 't' });
      expect(held.ok).toBe(true);
      const shown = (await Storefront.productsByIds([id])).find((p) => p.id === id);
      const available = availableOf(shown ?? { stockQuantity: 0, reservedQuantity: 0 });
      expect(available).toBe(4);
      expect((await c.stockReservations.reserve({ companyId, refType: 'order', refId: `ord_${randomUUID()}`, lines: [{ productId: id, quantity: available }], channel: 'ecommerce', actor: 't' })).ok).toBe(true);
      expect((await c.stockReservations.reserve({ companyId, refType: 'order', refId: `ord_${randomUUID()}`, lines: [{ productId: id, quantity: 1 }], channel: 'ecommerce', actor: 't' })).ok).toBe(false);
      expect(availableOf((await Storefront.productsByIds([id])).find((p) => p.id === id) ?? { stockQuantity: 0, reservedQuantity: 0 })).toBe(0);
    });

    it('lists only products the shop can sell when asked for what is in stock, and not one whose stock is all in quarantine', async () => {
      const [sellable, parked, orderOnly] = [await product('Sellable'), await product('Parked'), await product('OrdersOnly')];
      await put(sellable, 3, main);
      await put(parked, 8, quarantine);
      await put(orderOnly, 8, backOffice);
      const inStock = names(await search({ inStock: true }));
      expect(inStock).toContain('Sellable');
      expect(inStock).not.toContain('Parked');
      expect(inStock).not.toContain('OrdersOnly');
      expect(names(await search())).toEqual(expect.arrayContaining(['Sellable', 'Parked', 'OrdersOnly']));
      const shown = (await search()).products;
      expect(availableOf(shown.find((p) => p.id === parked) ?? { stockQuantity: 1, reservedQuantity: 0 })).toBe(0);
    });

    it('serves the product page the same figures, and sells again once stock arrives at a place that sells', async () => {
      const id = await product('Page');
      await put(id, 4, quarantine);
      const { CatalogService } = await import('@/server/domains/catalog/service');
      const before = await CatalogService.getPublicProduct(id);
      expect(availableOf((await availability.withShopAvailability(before === undefined ? [] : [before]))[0] ?? { stockQuantity: 9, reservedQuantity: 0 })).toBe(0);
      await put(id, 2, main);
      const after = await CatalogService.getPublicProduct(id);
      expect(availableOf((await availability.withShopAvailability(after === undefined ? [] : [after]))[0] ?? { stockQuantity: 0, reservedQuantity: 0 })).toBe(2);
    });

    it('shows a product with no stock anywhere as none, not as its counter', async () => {
      const id = await product('Empty', 5);
      expect(availableOf((await search()).products.find((p) => p.id === id) ?? { stockQuantity: 9, reservedQuantity: 0 })).toBe(0);
    });
  });
});
