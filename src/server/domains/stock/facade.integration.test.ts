import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as InventoryModule from '@/server/domains/inventory/service';
import type { ShadowReport, StockShadow } from './shadow';

/**
 * The old stock operations on top of the per-location ledger: with the ledger as the truth, receipts, adjustments, write-offs, counts,
 * returns and opening stock all become movements at a location, the product's counters follow, and the old journal still agrees.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('the old stock operations on the ledger (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let inv: typeof InventoryModule;
  let companyId: string;
  let itemTypeId: string;
  let main: string;

  const newProduct = async (over: Record<string, unknown> = {}) => {
    const id = `prod_fc_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `FC-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `FCS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Facade ${id.slice(-6)}`, slug: `fc-${randomUUID()}`, itemTypeId, price: '100', costPrice: '40', stockQuantity: 0, taxRate: '0', isTaxInclusive: true, ...over });
    return id;
  };
  const moves = async (productId: string) => await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.productId, productId)).orderBy(schema.stockMovements.id);
  const journal = async (productId: string) => await db.select().from(schema.inventoryMovements).where(eq(schema.inventoryMovements.productId, productId)).orderBy(schema.inventoryMovements.createdAt);
  const counters = async (productId: string) => (await db.select({ s: schema.products.stockQuantity, r: schema.products.reservedQuantity, cost: schema.products.costPrice }).from(schema.products).where(eq(schema.products.id, productId)))[0];
  const onHand = async (productId: string, locationId = main) => (await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, locationId)))).reduce((a, r) => a + r.onHand, 0);
  const move = (productId: string, delta: number, changeType: string, over: Record<string, unknown> = {}) =>
    db.transaction((tx) => inv.applyStockDelta(tx, { productId, delta, changeType, referenceId: `REF-${randomUUID().slice(0, 6)}`, actor: 'tester', note: 'test', ...over }));
  const codeOf = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (error) {
      return (error as { code?: string }).code ?? (error as Error).message;
    }
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    inv = await import('@/server/domains/inventory/service');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    itemTypeId = `it_fc_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    main = (await c.stockLocations.ensureDefault(companyId)).id;
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  });
  afterAll(async () => {
    await c.stockSettings.setLedgerMode(companyId, false);
  });

  describe('a change of stock', () => {
    it('is a movement at the default location, with the old journal row beside it and the counters following', async () => {
      const p = await newProduct();
      const delta = await move(p, 12, 'purchase_order_receipt', { costPrice: 41.5, referenceId: 'GRN-1', note: 'delivery' });
      expect(delta).toBe(12);
      expect(await onHand(p)).toBe(12);
      expect(await counters(p)).toMatchObject({ s: 12, r: 0, cost: '41.50' });
      const [m] = await moves(p);
      expect(m).toMatchObject({ movementType: 'receipt', quantity: 12, unitCost: '41.5000', locationId: main, documentType: 'inventory_journal', documentId: 'GRN-1', actorType: 'user', actorId: 'tester', note: 'delivery', migrated: false });
      const [j] = await journal(p);
      expect(j).toMatchObject({ changeType: 'purchase_order_receipt', changeAmount: 12, previousStock: 0, newStock: 12, referenceId: 'GRN-1' });
    });

    it('can be made at another location, and then only that location changes', async () => {
      const p = await newProduct();
      const shed = await c.stockLocations.create(companyId, { code: `FS${randomUUID().slice(0, 6)}`, name: 'Shed', kind: 'store' });
      await move(p, 5, 'purchase_order_receipt');
      await move(p, 3, 'purchase_order_receipt', { locationId: shed.id });
      expect(await onHand(p, main)).toBe(5);
      expect(await onHand(p, shed.id)).toBe(3);
      expect((await counters(p))?.s).toBe(8);
      expect((await journal(p)).at(-1)).toMatchObject({ previousStock: 5, newStock: 8 });
    });

    it('sets stock to a counted figure by moving the difference, and clamps at zero when asked', async () => {
      const p = await newProduct();
      await move(p, 10, 'purchase_order_receipt');
      expect(await db.transaction((tx) => inv.applyStockDelta(tx, { productId: p, delta: 0, setTo: 7, changeType: 'physical_audit', referenceId: 'CNT-1', actor: 't', note: 'count' }))).toBe(-3);
      expect(await onHand(p)).toBe(7);
      expect((await moves(p)).at(-1)).toMatchObject({ movementType: 'count_variance', quantity: -3 });
      expect(await db.transaction((tx) => inv.applyStockDelta(tx, { productId: p, delta: -50, clampAtZero: true, changeType: 'manual_adjustment', referenceId: 'ADJ-1', actor: 't', note: 'x' }))).toBe(-7);
      expect(await onHand(p)).toBe(0);
    });

    it('writes no movement for a change of nothing, but still the journal row', async () => {
      const p = await newProduct();
      await move(p, 0, 'manual_adjustment', { costPrice: 55 });
      expect(await moves(p)).toEqual([]);
      expect(await journal(p)).toHaveLength(1);
      expect((await counters(p))?.cost).toBe('55.00');
    });

    it('is refused when it would take a place below zero, in words, and leaves everything as it was', async () => {
      const p = await newProduct();
      await move(p, 4, 'purchase_order_receipt');
      const problem = await db.transaction((tx) => inv.applyStockDelta(tx, { productId: p, delta: -5, changeType: 'damage_writeoff', referenceId: 'WO-1', actor: 't', note: 'x' })).catch((e: unknown) => e as Error);
      expect(problem).toMatchObject({ code: 'INSUFFICIENT' });
      expect(await onHand(p)).toBe(4);
      expect(await journal(p)).toHaveLength(1);
    });

    it('is refused when it tries to change holds, which belong to the reservation ledger', async () => {
      const p = await newProduct();
      await move(p, 4, 'purchase_order_receipt');
      expect(await codeOf(move(p, 1, 'order_cancellation_release', { reservedDelta: -1 }))).toMatch(/reservation ledger/);
    });

    it('keeps the stock in the product’s own unit: a piece cannot be 2.5', async () => {
      const p = await newProduct();
      await move(p, 2, 'purchase_order_receipt');
      const problem = await move(p, 0.5, 'purchase_order_receipt').catch((e: unknown) => e as Error);
      expect((problem as Error).message).toMatch(/must be a whole number/);
      expect(await onHand(p)).toBe(2);
      expect(await moves(p)).toHaveLength(1);
    });
  });

  describe('the operations people use', () => {
    it('adjust, receive, write off, count and adjust in bulk all land in the ledger with their own kind of movement', async () => {
      const p = await newProduct();
      const q = await newProduct();
      await inv.InventoryDomainService.receive(p, 20, 'Supplier', 'PO-9', 45, 'first');
      await inv.InventoryDomainService.adjust(p, 25, 'recount');
      await inv.InventoryDomainService.writeOff(p, 5, 'damage_transit', 'broken');
      const audited = await inv.InventoryDomainService.audit(p, 19, 'shelf count');
      expect(audited.discrepancy).toBe(-1);
      await inv.InventoryDomainService.batchAdjust([{ productId: p, newQuantity: 30, reason: 'bulk' }, { productId: q, newQuantity: 8, reason: 'bulk' }]);
      expect((await moves(p)).map((m) => [m.movementType, m.quantity])).toEqual([['receipt', 20], ['adjustment', 5], ['write_off', -5], ['count_variance', -1], ['adjustment', 11]]);
      expect((await moves(q)).map((m) => [m.movementType, m.quantity])).toEqual([['adjustment', 8]]);
      expect(await onHand(p)).toBe(30);
      expect(await counters(p)).toMatchObject({ s: 30, cost: '45.00' });
      expect(await counters(q)).toMatchObject({ s: 8 });
    });

    it('refuse to write off more than there is', async () => {
      const p = await newProduct();
      await inv.InventoryDomainService.adjust(p, 3);
      await expect(inv.InventoryDomainService.writeOff(p, 4, 'damage_transit')).rejects.toThrow(/only 3 currently on hand/);
      expect(await onHand(p)).toBe(3);
    });
  });

  describe('opening stock', () => {
    it('becomes an opening movement beside the journal row, once', async () => {
      const p = await newProduct({ stockQuantity: 9 });
      await db.transaction((tx) => inv.recordOpeningStock(tx, { productId: p, productName: 'x', quantity: 9, costPrice: 40, referenceId: 'PRODUCT_CREATION', actor: 'admin', note: 'created' }));
      expect(await onHand(p)).toBe(9);
      expect((await moves(p)).map((m) => [m.movementType, m.quantity, m.documentType])).toEqual([['opening', 9, 'product_creation']]);
      expect(await journal(p)).toHaveLength(1);
      expect((await counters(p))?.s).toBe(9);
    });

    it('writes nothing to the ledger for a product created with no stock', async () => {
      const p = await newProduct();
      await db.transaction((tx) => inv.recordOpeningStock(tx, { productId: p, productName: 'x', quantity: 0, costPrice: 40, referenceId: 'PRODUCT_CREATION', actor: 'admin', note: 'created' }));
      expect(await moves(p)).toEqual([]);
    });
  });

  describe('the old journal and the ledger agree', () => {
    it('so the comparison is clean after any mix of operations, and finds a difference when one is planted', async () => {
      const p = await newProduct();
      await move(p, 30, 'purchase_order_receipt');
      await inv.InventoryDomainService.writeOff(p, 4, 'damage_transit');
      await inv.InventoryDomainService.audit(p, 20);
      const clean = await c.stockShadow.compare({ productIds: [p] });
      expect(clean).toMatchObject({ products: 1, onHandDiffers: 0, reservedDiffers: 0, ledgerDiffers: 0, journalDiffers: 0, reservationsDiffer: 0, sample: [] });
      // A journal row with no movement behind it: the old and the new side no longer tell the same story.
      await db.insert(schema.inventoryMovements).values({ id: `ledger_${randomUUID()}`, productId: p, productName: 'x', changeAmount: 3, previousStock: 20, newStock: 23, changeType: 'manual_adjustment', referenceId: 'PLANTED', actor: 't', note: '' });
      const dirty = await c.stockShadow.compare({ productIds: [p] });
      expect(dirty.journalDiffers).toBe(1);
      expect(dirty.sample).toEqual([expect.objectContaining({ kind: 'journal_differs', productId: p, expected: 23, found: 20 })]);
    });

    it('limits a check to the products asked for, and to none when none are', async () => {
      const [a, b] = [await newProduct(), await newProduct()];
      await db.update(schema.products).set({ stockQuantity: 5 }).where(eq(schema.products.id, a));
      expect((await c.stockShadow.compare({ productIds: [b] })).onHandDiffers).toBe(0);
      expect((await c.stockShadow.compare({ productIds: [a] })).onHandDiffers).toBe(1);
      expect((await c.stockShadow.compare({ productIds: [] })).products).toBe(0);
      await db.update(schema.products).set({ stockQuantity: 0 }).where(eq(schema.products.id, a));
    });
  });

  describe('switching the ledger on', () => {
    const report = (over: Partial<ShadowReport> = {}): ShadowReport => ({ products: 3, onHandDiffers: 0, reservedDiffers: 0, ledgerDiffers: 0, negative: 0, reservationsDiffer: 0, journalDiffers: 0, sample: [], ...over });
    const fake = (status: { shadowWrite: boolean; backfillDoneAt: Date | null }, r: ShadowReport) =>
      ({ status: () => Promise.resolve({ ...status, backfillCursor: null }), compare: () => Promise.resolve(r) }) as unknown as StockShadow;

    it('is refused without a shadow that has finished, or while anything differs, and says why', async () => {
      await c.stockSettings.setLedgerMode(companyId, false);
      expect(await codeOf(c.stockSettings.setLedgerMode(companyId, true))).toBe('NEEDS_SHADOW');
      expect(await codeOf(c.stockSettings.setLedgerMode(companyId, true, { shadow: fake({ shadowWrite: false, backfillDoneAt: null }, report()) }))).toBe('SHADOW_NOT_DONE');
      expect(await codeOf(c.stockSettings.setLedgerMode(companyId, true, { shadow: fake({ shadowWrite: true, backfillDoneAt: null }, report()) }))).toBe('SHADOW_NOT_DONE');
      const problem = await c.stockSettings.setLedgerMode(companyId, true, { shadow: fake({ shadowWrite: true, backfillDoneAt: new Date() }, report({ onHandDiffers: 2, journalDiffers: 1 })) }).catch((e: unknown) => e as Error);
      expect(problem).toMatchObject({ code: 'SHADOW_DIFFERS' });
      expect((problem as Error).message).toContain('3 item(s)');
      expect(await c.stockSettings.isLedgerMode()).toBe(false);
    });

    it('goes ahead when the shadow has finished and nothing differs, and that ends the shadow', async () => {
      await c.stockSettings.setLedgerMode(companyId, true, { shadow: fake({ shadowWrite: true, backfillDoneAt: new Date() }, report()) });
      expect(await c.stockSettings.get()).toMatchObject({ ledgerMode: true, shadowWrite: false });
      await c.stockSettings.setLedgerMode(companyId, false);
      expect(await c.stockSettings.isLedgerMode()).toBe(false);
      await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    });

    it('rehearsed on real products: old stock, the shadow, the backfill, a clean comparison, then the new path', async () => {
      await c.stockSettings.setLedgerMode(companyId, false);
      const p = await newProduct();
      await move(p, 25, 'purchase_order_receipt').catch(() => undefined);
      // The old way (no ledger), then bring it across.
      await db.update(schema.products).set({ stockQuantity: 25 }).where(eq(schema.products.id, p));
      await c.stockShadow.setShadow(companyId, true);
      expect(await c.stockShadow.backfillProduct(companyId, p)).toBe(true);
      expect(await c.stockShadow.compare({ productIds: [p] })).toMatchObject({ onHandDiffers: 0, ledgerDiffers: 0 });
      await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      await inv.InventoryDomainService.writeOff(p, 5, 'damage_transit');
      expect(await onHand(p)).toBe(20);
      expect(await counters(p)).toMatchObject({ s: 20 });
      expect((await c.stockShadow.compare({ productIds: [p] })).onHandDiffers).toBe(0);
    });
  });
});
