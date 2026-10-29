import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import { STOCK_MOVEMENT_TYPES, movementTypeOfJournal } from '@/lib/stock';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as InventoryModule from '@/server/domains/inventory/service';
import type * as ReservationModule from '@/server/domains/inventory/reservation-service';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';

/**
 * Stock per location against a real database: locations, the ledger and its balances, availability, and the shadow of the migration
 * (the triggers that mirror the old counters, the backfill that brings old stock across, and the comparison that proves they agree).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('stock per location (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let inventory: typeof InventoryModule;
  let Reservations: typeof ReservationModule.InventoryReservationService;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let main: string;

  const created: string[] = [];
  const newProduct = async (stock = 0, extra: Record<string, unknown> = {}) => {
    const id = `prod_st_${randomUUID()}`;
    created.push(id);
    await db.insert(schema.products).values({ id, sku: `ST-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `STS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Stock ${id.slice(-6)}`, slug: `st-${randomUUID()}`, itemTypeId, price: '100', costPrice: '40', stockQuantity: stock, taxRate: '0', isTaxInclusive: true, ...extra });
    return id;
  };
  /** A change of stock the way the application makes it: the old counters and the old journal. */
  const oldWay = async (productId: string, delta: number, changeType = 'manual_adjustment', reservedDelta = 0) =>
    await db.transaction((tx) => inventory.applyStockDelta(tx, { productId, delta, reservedDelta, changeType, referenceId: `REF-${randomUUID().slice(0, 6)}`, actor: 'tester', note: 'test' }));
  const balance = async (productId: string, locationId = main) => {
    const rows = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, locationId)));
    return { onHand: rows.reduce((a, r) => a + r.onHand, 0), reserved: rows.reduce((a, r) => a + r.reserved, 0), rows: rows.length };
  };
  const movements = async (productId: string) => await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.productId, productId)).orderBy(schema.stockMovements.id);
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).message;
    }
  };
  const ledgerPost = (productId: string, quantity: number, over: Record<string, unknown> = {}) =>
    db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId: main, type: 'adjustment', quantity, actor: { type: 'job' }, ...over }));

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    inventory = await import('@/server/domains/inventory/service');
    ({ InventoryReservationService: Reservations } = await import('@/server/domains/inventory/reservation-service'));
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Stock Test Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    itemTypeId = `it_st_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    main = (await c.stockLocations.ensureDefault(companyId)).id;
  });
  afterAll(async () => {
    await c.stockShadow.setShadow(companyId, false);
  });

  describe('locations', () => {
    it('start with one default, made once however often it is asked for', async () => {
      const [a, b] = await Promise.all([c.stockLocations.ensureDefault(companyId), c.stockLocations.ensureDefault(companyId)]);
      expect(a.id).toBe(b.id);
      expect(a).toMatchObject({ code: 'MAIN', isDefault: true, isActive: true, kind: 'warehouse' });
      const defaults = (await c.stockLocations.list(companyId, true)).filter((l) => l.isDefault);
      expect(defaults).toHaveLength(1);
    });

    it('are made, found, changed, and refused when the code is taken or the branch is not the company’s', async () => {
      const code = `W${randomUUID().slice(0, 6)}`;
      const made = await c.stockLocations.create(companyId, { code, name: 'Second warehouse', kind: 'warehouse', branchId });
      expect(made).toMatchObject({ code, branchId, isDefault: false, sellsChannels: ['ecommerce', 'sales_order', 'credit_sale', 'pos_cash_sale'] });
      expect(await codeOf(c.stockLocations.create(companyId, { code: code.toLowerCase(), name: 'Again', kind: 'store' }))).toBe('DUPLICATE_CODE');
      expect(await codeOf(c.stockLocations.create(companyId, { code: 'X1', name: 'Nowhere', kind: 'store', branchId: randomUUID() }))).toBe('BAD_BRANCH');
      expect(await codeOf(c.stockLocations.create(companyId, { code: 'X2', name: 'Bad', kind: 'shed' }))).toBe('BAD_LOCATION');
      expect(await codeOf(c.stockLocations.get(companyId, randomUUID()))).toBe('NOT_FOUND');
      const changed = await c.stockLocations.update(companyId, made.id, { code, name: 'Renamed', kind: 'store', sellsChannels: ['ecommerce'] });
      expect(changed).toMatchObject({ name: 'Renamed', kind: 'store', sellsChannels: ['ecommerce'] });
    });

    it('hand over the default in one step, and never leave a company without one', async () => {
      const other = await c.stockLocations.create(companyId, { code: `D${randomUUID().slice(0, 6)}`, name: 'Next default', kind: 'warehouse' });
      await c.stockLocations.makeDefault(companyId, other.id);
      let defaults = (await c.stockLocations.list(companyId, true)).filter((l) => l.isDefault);
      expect(defaults.map((l) => l.id)).toEqual([other.id]);
      await c.stockLocations.makeDefault(companyId, main);
      defaults = (await c.stockLocations.list(companyId, true)).filter((l) => l.isDefault);
      expect(defaults.map((l) => l.id)).toEqual([main]);
      expect(await codeOf(c.stockLocations.deactivate(companyId, main))).toBe('IS_DEFAULT');
    });

    it('cannot be stopped while they hold stock, and can once emptied; a stopped one takes no movements', async () => {
      const loc = await c.stockLocations.create(companyId, { code: `S${randomUUID().slice(0, 6)}`, name: 'Shed', kind: 'store' });
      const p = await newProduct();
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: loc.id, type: 'receipt', quantity: 5, actor: { type: 'job' } }));
      expect(await codeOf(c.stockLocations.deactivate(companyId, loc.id))).toBe('HAS_STOCK');
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: loc.id, type: 'adjustment', quantity: -5, actor: { type: 'job' } }));
      await c.stockLocations.deactivate(companyId, loc.id);
      expect((await c.stockLocations.list(companyId)).some((l) => l.id === loc.id)).toBe(false);
      expect(await codeOf(db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: loc.id, type: 'receipt', quantity: 1, actor: { type: 'job' } })))).toBe('INACTIVE');
      await c.stockLocations.reactivate(companyId, loc.id);
      expect((await c.stockLocations.list(companyId)).some((l) => l.id === loc.id)).toBe(true);
    });
  });

  describe('the ledger', () => {
    it('writes the movement and the balance together, with the cost and who did it', async () => {
      const p = await newProduct();
      const r = await ledgerPost(p, 12.5, { type: 'receipt', unitCost: 41.25, documentType: 'grn', documentId: 'G1', actor: { type: 'user', id: 'u1' }, note: 'first' });
      expect(r).toMatchObject({ posted: true, onHand: 12.5 });
      expect(await balance(p)).toMatchObject({ onHand: 12.5, reserved: 0 });
      const [m] = await movements(p);
      expect(m).toMatchObject({ movementType: 'receipt', quantity: 12.5, unitCost: '41.2500', documentType: 'grn', documentId: 'G1', actorType: 'user', actorId: 'u1', note: 'first', locationId: main, migrated: false });
      expect(m?.id).toBeGreaterThan(0);
    });

    it('does a line of a document once: a retry changes nothing', async () => {
      const p = await newProduct();
      const line = { documentType: 'grn', documentId: 'G2', documentLineId: 'L1', type: 'receipt' as const };
      expect((await ledgerPost(p, 10, line)).posted).toBe(true);
      const again = await ledgerPost(p, 10, line);
      expect(again).toMatchObject({ posted: false, movementId: null, onHand: 10 });
      expect(await balance(p)).toMatchObject({ onHand: 10 });
      expect(await movements(p)).toHaveLength(1);
    });

    it('refuses to go below zero unless the location allows it, and says how much is there', async () => {
      const p = await newProduct();
      await ledgerPost(p, 3);
      const problem = await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: main, type: 'sale_issue', quantity: -4, actor: { type: 'job' } })).catch((e: unknown) => e as Error);
      expect(problem).toMatchObject({ code: 'INSUFFICIENT' });
      expect((problem as Error).message).toContain('3 on hand');
      expect(await balance(p)).toMatchObject({ onHand: 3 });
      const till = await c.stockLocations.create(companyId, { code: `T${randomUUID().slice(0, 6)}`, name: 'Till', kind: 'store', allowNegative: true });
      const r = await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: till.id, type: 'sale_issue', quantity: -2, actor: { type: 'job' } }));
      expect(r.onHand).toBe(-2);
    });

    it.each([
      ['zero', 0],
      ['more than three decimals', 1.0005],
      ['not a number', Number.NaN],
    ])('refuses a quantity that is %s', async (_n, q) => {
      expect(await codeOf(ledgerPost(await newProduct(), q))).toBe('BAD_QUANTITY');
    });

    it('refuses an unknown type, a line without a document type, and a location of another company', async () => {
      const p = await newProduct();
      expect(await codeOf(ledgerPost(p, 1, { type: 'made_up' }))).toBe('BAD_TYPE');
      expect(await codeOf(ledgerPost(p, 1, { documentLineId: 'L' }))).toBe('BAD_DOCUMENT');
      expect(await codeOf(ledgerPost(p, 1, { companyId: randomUUID() }))).toBe('NOT_FOUND');
    });

    it('lets exactly the stock there is be sold when many sales arrive at once', async () => {
      const p = await newProduct();
      await ledgerPost(p, 10, { type: 'receipt' });
      const results = await Promise.all(Array.from({ length: 25 }, () => codeOf(ledgerPost(p, -1, { type: 'sale_issue' }))));
      expect(results.filter((r) => r === 'OK')).toHaveLength(10);
      expect(results.filter((r) => r === 'INSUFFICIENT')).toHaveLength(15);
      expect(await balance(p)).toMatchObject({ onHand: 0 });
      expect((await movements(p)).reduce((a, m) => a + m.quantity, 0)).toBe(0);
    });

    it('does not deadlock when baskets name the same products in opposite orders', async () => {
      const [a, b, d] = [await newProduct(), await newProduct(), await newProduct()];
      for (const p of [a, b, d]) await ledgerPost(p, 100, { type: 'receipt' });
      const basket = (ids: string[]) => c.stockLedger.postMany(ids.map((productId) => ({ companyId, productId, locationId: main, type: 'sale_issue' as const, quantity: -1, actor: { type: 'job' as const } })));
      await Promise.all(Array.from({ length: 20 }, (_x, i) => basket(i % 2 === 0 ? [a, b, d] : [d, b, a])));
      for (const p of [a, b, d]) expect(await balance(p)).toMatchObject({ onHand: 80 });
    });

    it('conserves stock: after any run of movements the balance is the sum of the ledger', async () => {
      const p = await newProduct();
      let seed = 7;
      const next = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
      await ledgerPost(p, 500, { type: 'receipt' });
      for (let i = 0; i < 60; i++) {
        const q = Math.round((next() * 20 - 10) * 100) / 100;
        if (q !== 0) await ledgerPost(p, q).catch(() => undefined);
      }
      const b = await balance(p);
      const sum = Math.round((await movements(p)).reduce((a, m) => a + m.quantity, 0) * 1000) / 1000;
      expect(b.onHand).toBe(sum);
      expect(b.onHand).toBeGreaterThanOrEqual(0);
    });

    it('is append-only, and a movement type cannot be invented in the database either', async () => {
      const p = await newProduct();
      const r = await ledgerPost(p, 1);
      await expect(db.update(schema.stockMovements).set({ quantity: 99 }).where(eq(schema.stockMovements.id, r.movementId ?? 0))).rejects.toThrow();
      await expect(db.delete(schema.stockMovements).where(eq(schema.stockMovements.id, r.movementId ?? 0))).rejects.toThrow();
      await expect(db.execute(sql`INSERT INTO stock_movements (company_id, product_id, location_id, movement_type, quantity) VALUES (${companyId}::uuid, ${p}, ${main}::uuid, 'invented', 1)`)).rejects.toThrow();
      await expect(db.execute(sql`INSERT INTO stock_movements (company_id, product_id, location_id, movement_type, quantity) VALUES (${companyId}::uuid, ${p}, ${main}::uuid, 'receipt', 0)`)).rejects.toThrow();
    });
  });

  describe('availability', () => {
    it('sums what can be promised over the places that sell to the channel, and ignores the rest', async () => {
      const p = await newProduct();
      const shop = await c.stockLocations.create(companyId, { code: `A${randomUUID().slice(0, 6)}`, name: 'Online only', kind: 'warehouse', sellsChannels: ['ecommerce'] });
      const back = await c.stockLocations.create(companyId, { code: `B${randomUUID().slice(0, 6)}`, name: 'Orders only', kind: 'warehouse', sellsChannels: ['sales_order'] });
      const quarantine = await c.stockLocations.create(companyId, { code: `Q${randomUUID().slice(0, 6)}`, name: 'Quarantine', kind: 'quarantine', isSellable: false });
      const put = (locationId: string, quantity: number) => db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId, type: 'receipt', quantity, actor: { type: 'job' } }));
      await put(shop.id, 10);
      await put(back.id, 7);
      await put(quarantine.id, 99);
      await db.update(schema.stockBalances).set({ reserved: 3 }).where(and(eq(schema.stockBalances.productId, p), eq(schema.stockBalances.locationId, shop.id)));
      expect(await c.stockAvailability.forProduct(p, 'ecommerce')).toEqual({ onHand: 10, reserved: 3, available: 7 });
      expect(await c.stockAvailability.forProduct(p, 'sales_order')).toEqual({ onHand: 7, reserved: 0, available: 7 });
      expect(await c.stockAvailability.forProduct(p, 'pos_cash_sale')).toEqual({ onHand: 0, reserved: 0, available: 0 });
      await c.stockLocations.update(companyId, shop.id, { code: shop.code, name: 'Online only', kind: 'warehouse', sellsChannels: ['ecommerce'], isSellable: false });
      expect((await c.stockAvailability.forProduct(p, 'ecommerce')).available).toBe(0);
    });

    it('answers many products in one go, with nothing for a product with no stock', async () => {
      const [a, b] = [await newProduct(), await newProduct()];
      await ledgerPost(a, 4, { type: 'receipt' });
      const map = await c.stockAvailability.forProducts([a, b, a, 'prod_missing'], 'ecommerce');
      expect([...map.keys()].sort()).toEqual([a, b, 'prod_missing'].sort());
      expect(map.get(a)?.available).toBe(4);
      expect(map.get(b)).toEqual({ onHand: 0, reserved: 0, available: 0 });
      expect((await c.stockAvailability.forProducts([], 'ecommerce')).size).toBe(0);
    });
  });

  describe('the shadow of the old counters', () => {
    // The tests above post straight to the ledger, which the shadow phase never does; their products would only be noise in the comparison.
    beforeAll(async () => {
      await db.delete(schema.products).where(inArray(schema.products.id, created.splice(0)));
    });

    it('does nothing while it is off', async () => {
      await c.stockShadow.setShadow(companyId, false);
      const p = await newProduct();
      await oldWay(p, 5, 'purchase_order_receipt');
      expect(await movements(p)).toEqual([]);
      expect((await balance(p)).rows).toBe(0);
    });

    it('mirrors every kind of change the application makes, with the ledger’s word for it', async () => {
      await c.stockShadow.setShadow(companyId, true);
      const p = await newProduct();
      const kinds = ['purchase_order_receipt', 'restock', 'purchase_receipt_reversal', 'purchase_return', 'credit_note_restock', 'manual_adjustment', 'physical_audit', 'damage_writeoff', 'product_deleted', 'product_restored', 'order_fulfillment'];
      for (const k of kinds) await oldWay(p, 20, k);
      const got = (await movements(p)).map((m) => m.movementType);
      expect(got).toEqual(kinds.map((k) => movementTypeOfJournal(k)));
      for (const t of got) expect(STOCK_MOVEMENT_TYPES).toContain(t);
      expect(await balance(p)).toMatchObject({ onHand: 20 * kinds.length });
      const [first] = await movements(p);
      expect(first).toMatchObject({ actorType: 'legacy', documentType: 'inventory_journal', locationId: main, migrated: false, unitCost: '40.0000' });
      expect(first?.legacyMovementId).toMatch(/^ledger_/);
    });

    it('follows holds and releases through the reserved counter, and a fulfilled order through both', async () => {
      await c.stockShadow.setShadow(companyId, true);
      const p = await newProduct(0);
      await oldWay(p, 30, 'purchase_order_receipt');
      const held = await Reservations.reserveForOrder([{ productId: p, quantity: 4 }], `HOLD-${randomUUID().slice(0, 6)}`);
      expect(held.success).toBe(true);
      expect(await balance(p)).toMatchObject({ onHand: 30, reserved: 4 });
      const release = `HOLD-${randomUUID().slice(0, 6)}`;
      await Reservations.reserveForOrder([{ productId: p, quantity: 5 }], release);
      expect((await balance(p)).reserved).toBe(9);
      await Reservations.releaseOrder(release, 'test', 'tester', [{ productId: p, quantity: 5 }]);
      expect(await balance(p)).toMatchObject({ onHand: 30, reserved: 4 });
      const result = await createOrder({
        branchId,
        orderNumber: `ST-${randomUUID()}`,
        customerName: 'Stock Buyer',
        customerEmail: `st-${randomUUID()}@stock.test`,
        customerPhone: '0700000000',
        shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
        items: [{ productId: p, quantity: 3 }],
        currency: 'KES',
        paymentMethod: 'mpesa_daraja',
      });
      expect(result.success, result.error).toBe(true);
      expect(await balance(p)).toMatchObject({ onHand: 30, reserved: 7 });
      await Reservations.fulfilOrder(result.order?.id ?? '');
      expect(await balance(p)).toMatchObject({ onHand: 27, reserved: 4 });
      expect((await movements(p)).at(-1)).toMatchObject({ movementType: 'sale_issue', quantity: -3 });
    });

    it('brings old stock across: history copied once, an opening balance for what it does not explain, and the counters as the balance', async () => {
      await c.stockShadow.setShadow(companyId, false);
      const p = await newProduct(0);
      await oldWay(p, 40, 'purchase_order_receipt');
      await oldWay(p, -5, 'order_fulfillment');
      // Stock that arrived without a journal row (an import, for example), and a hold.
      await db.update(schema.products).set({ stockQuantity: 50, reservedQuantity: 2 }).where(eq(schema.products.id, p));
      expect(await movements(p)).toEqual([]);
      await c.stockShadow.setShadow(companyId, true);
      expect(await c.stockShadow.backfillProduct(companyId, p)).toBe(true);
      expect(await c.stockShadow.backfillProduct(companyId, p)).toBe(true);
      const all = await movements(p);
      expect(all.map((m) => [m.movementType, m.quantity, m.migrated])).toEqual([
        ['receipt', 40, true],
        ['sale_issue', -5, true],
        ['opening', 15, true],
      ]);
      expect(await balance(p)).toMatchObject({ onHand: 50, reserved: 2, rows: 1 });
    });

    it('does not lose a sale that lands while a product is being brought across', async () => {
      await c.stockShadow.setShadow(companyId, true);
      const p = await newProduct(0);
      await oldWay(p, 100, 'purchase_order_receipt');
      await Promise.all([c.stockShadow.backfillProduct(companyId, p), oldWay(p, -7, 'order_fulfillment'), oldWay(p, -3, 'order_fulfillment'), c.stockShadow.backfillProduct(companyId, p)]);
      const live = (await db.select({ s: schema.products.stockQuantity }).from(schema.products).where(eq(schema.products.id, p)))[0]?.s;
      expect(live).toBe(90);
      expect(await balance(p)).toMatchObject({ onHand: 90 });
      expect((await movements(p)).reduce((a, m) => a + m.quantity, 0)).toBe(90);
    });

    it('works through the whole catalogue in slices and then reports that the two sides agree', async () => {
      await c.stockShadow.setShadow(companyId, false);
      const made = [await newProduct(8), await newProduct(0), await newProduct(21)];
      await oldWay(made[1] ?? '', 6, 'purchase_order_receipt');
      await c.stockShadow.setShadow(companyId, true);
      let finished = false;
      for (let i = 0; i < 500 && !finished; i++) finished = (await c.stockShadow.backfillBatch(companyId, 50)).finished;
      expect(finished).toBe(true);
      expect((await c.stockShadow.status(companyId)).backfillDoneAt).toBeInstanceOf(Date);
      const report = await c.stockShadow.compare();
      expect(report).toMatchObject({ onHandDiffers: 0, reservedDiffers: 0, ledgerDiffers: 0, negative: 0, sample: [] });
      for (const [i, id] of made.entries()) expect((await balance(id)).onHand, `product ${String(i)}`).toBe([8, 6, 21][i]);
      expect((await c.stockShadow.backfillBatch(companyId)).finished).toBe(true);
    });

    it('refuses to start the backfill with the shadow off, and says why', async () => {
      await c.stockShadow.setShadow(companyId, false);
      expect(await codeOf(c.stockShadow.backfillBatch(companyId))).toBe('SHADOW_OFF');
    });

    it('finds a difference when the two sides disagree, with the product and both numbers', async () => {
      await c.stockShadow.setShadow(companyId, true);
      const p = await newProduct(0);
      await oldWay(p, 12, 'purchase_order_receipt');
      await c.stockShadow.backfillProduct(companyId, p);
      await db.update(schema.stockBalances).set({ onHand: 11, reserved: 1 }).where(eq(schema.stockBalances.productId, p));
      await db.update(schema.products).set({ stockQuantity: 13 }).where(eq(schema.products.id, p));
      const r = await c.stockShadow.compare();
      expect(r.onHandDiffers).toBeGreaterThanOrEqual(1);
      expect(r.reservedDiffers).toBeGreaterThanOrEqual(1);
      expect(r.ledgerDiffers).toBeGreaterThanOrEqual(1);
      expect(r.sample).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'on_hand_differs', productId: p, expected: 13, found: 11 }), expect.objectContaining({ kind: 'ledger_differs', productId: p, expected: 12, found: 11 })]));
      await db.update(schema.stockBalances).set({ onHand: 12, reserved: 0 }).where(eq(schema.stockBalances.productId, p));
      await db.update(schema.products).set({ stockQuantity: 12 }).where(eq(schema.products.id, p));
      expect((await c.stockShadow.compare()).sample.some((s) => s.productId === p)).toBe(false);
    });

    it('never stops a sale because the mirror could not be written', async () => {
      await c.stockShadow.setShadow(companyId, true);
      const p = await newProduct(0);
      // Make the mirror fail: a movement type check is the one thing it cannot satisfy.
      await db.execute(sql`ALTER TABLE stock_movements ADD CONSTRAINT stock_test_block CHECK (false) NOT VALID`);
      try {
        await expect(oldWay(p, 5, 'purchase_order_receipt')).resolves.toBe(5);
      } finally {
        await db.execute(sql`ALTER TABLE stock_movements DROP CONSTRAINT stock_test_block`);
      }
      const live = (await db.select({ s: schema.products.stockQuantity }).from(schema.products).where(eq(schema.products.id, p)))[0]?.s;
      expect(live).toBe(5);
      expect(await movements(p)).toEqual([]);
      expect((await c.stockShadow.compare()).sample.some((s) => s.productId === p)).toBe(true);
    });
  });
});
