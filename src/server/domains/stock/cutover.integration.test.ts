import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as InventoryModule from '@/server/domains/inventory/service';
import type * as ReservationModule from '@/server/domains/inventory/reservation-service';
import type * as TasksModule from '@/server/queue/tasks';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import { StockCutover } from './cutover';
import type { ShadowReport, StockShadow } from './shadow';
import { settleFinanceBacklog } from './test-support';

/**
 * Moving a company to the new stock ledger, against a real database: the old reservations becoming holds, the switch being one step
 * that changes nothing if the two sides differ, an order reserved the old way settling the new way, and going back. The comparison
 * is the real one, narrowed to the products of each test, because the database is shared with files that leave other products in
 * states the real cut-over would rightly refuse.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('moving to the new stock ledger (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let inv: typeof InventoryModule;
  let Reservations: typeof ReservationModule.InventoryReservationService;
  let tasks: typeof TasksModule;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let main: string;
  let cutover: StockCutover;
  const made: string[] = [];
  let mine: string[] = [];

  /** The real shadow, with its comparison narrowed to this test's products. */
  const scoped = (): StockShadow =>
    new Proxy(c.stockShadow, {
      get(target, prop, receiver) {
        if (prop === 'compare') return (o: Record<string, unknown> = {}) => target.compare({ ...o, productIds: mine });
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  const dirty = (): StockShadow =>
    new Proxy(c.stockShadow, {
      get(target, prop, receiver) {
        if (prop === 'compare') return (): Promise<ShadowReport> => Promise.resolve({ products: 1, onHandDiffers: 2, reservedDiffers: 0, ledgerDiffers: 0, negative: 0, reservationsDiffer: 0, journalDiffers: 0, sample: [] });
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  const cutoverWith = (shadow: StockShadow) => new StockCutover(db, shadow, c.stockLocations, c.decisionLog);

  const legacyProduct = async (stock: number) => {
    const id = `prod_co_${randomUUID()}`;
    made.push(id);
    mine.push(id);
    await db.insert(schema.products).values({ id, sku: `CO-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `COS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Cut ${id.slice(-6)}`, slug: `co-${randomUUID()}`, itemTypeId, price: '20', costPrice: '10', stockQuantity: 0 });
    if (stock > 0) await oldWay(id, stock);
    return id;
  };
  const oldWay = async (productId: string, delta: number, changeType = 'purchase_order_receipt') =>
    await db.transaction((tx) => inv.applyStockDelta(tx, { productId, delta, changeType, referenceId: `REF-${randomUUID().slice(0, 6)}`, actor: 'tester', note: 'test' }));
  const place = async (productId: string, quantity: number) => {
    const r = await createOrder({
      branchId,
      orderNumber: `CO-${randomUUID()}`,
      customerName: 'Cut Buyer',
      customerEmail: `co-${randomUUID()}@cut.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
    });
    expect(r.success, r.error).toBe(true);
    return r.order?.id ?? '';
  };
  const balance = async (productId: string) => {
    const rows = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, main)));
    return { onHand: rows.reduce((a, r) => a + r.onHand, 0), reserved: rows.reduce((a, r) => a + r.reserved, 0) };
  };
  const counters = async (productId: string) => (await db.select({ s: schema.products.stockQuantity, r: schema.products.reservedQuantity }).from(schema.products).where(eq(schema.products.id, productId)))[0];
  const holds = async (orderId: string) => await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.refId, orderId));
  const code = async (p: Promise<unknown>) => {
    try {
      await p;
      return 'OK';
    } catch (e) {
      return (e as { code?: string }).code ?? (e as Error).message;
    }
  };
  const finishBackfill = async () => {
    for (let i = 0; i < 200; i++) if ((await c.stockShadow.backfillBatch(companyId, 100)).finished) return;
  };
  /** The old way with the shadow on and everything brought across: where a company stands the day before the switch. */
  const dayBefore = async () => {
    await c.stockSettings.setLedgerMode(companyId, false);
    await c.stockShadow.setShadow(companyId, false);
    await c.stockShadow.setShadow(companyId, true);
    await finishBackfill();
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    inv = await import('@/server/domains/inventory/service');
    ({ InventoryReservationService: Reservations } = await import('@/server/domains/inventory/reservation-service'));
    tasks = await import('@/server/queue/tasks');
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    cutover = c.stockCutover;
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Cut-over Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    itemTypeId = `it_co_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    main = (await c.stockLocations.ensureDefault(companyId)).id;
  });
  afterAll(async () => {
    await c.stockSettings.setLedgerMode(companyId, false);
    await c.stockShadow.setShadow(companyId, false);
    if (made.length > 0) await db.delete(schema.products).where(inArray(schema.products.id, made));
    await settleFinanceBacklog(c.finance);
  }, 180_000);

  // Each test looks only at the products it makes.
  beforeEach(() => {
    mine = [];
  });

  describe('the steps', () => {
    it('say where the company stands: the old way, the shadow, or the new ledger', async () => {
      await c.stockSettings.setLedgerMode(companyId, false);
      await c.stockShadow.setShadow(companyId, false);
      expect((await cutover.status(companyId)).mode).toBe('off');
      await cutover.start(companyId, 'admin-1');
      expect((await cutover.status(companyId)).mode).toBe('shadow');
      expect(await code(cutover.start(companyId, 'admin-1'))).toBe('ALREADY_STARTED');
      await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      expect((await cutover.status(companyId)).mode).toBe('ledger');
      expect(await code(cutover.start(companyId, 'admin-1'))).toBe('ALREADY_ON');
      await c.stockSettings.setLedgerMode(companyId, false);
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, companyId), eq(schema.decisionLog.action, 'stock.ledger.shadow_started')));
      expect(log.length).toBeGreaterThanOrEqual(1);
    });

    it('keep the result of every check', async () => {
      await dayBefore();
      const p = await legacyProduct(4);
      await c.stockShadow.backfillProduct(companyId, p);
      const before = (await cutover.status(companyId)).lastRun;
      const { ok, report } = await cutoverWith(scoped()).check(companyId, 'manual', 'admin-1');
      expect(ok).toBe(true);
      expect(report.products).toBe(mine.length);
      const after = (await cutover.status(companyId)).lastRun;
      expect(after).toMatchObject({ trigger: 'manual', ok: true, ranBy: 'admin-1' });
      expect(after?.at).not.toBe(before?.at);
    });
  });

  describe('switching over', () => {
    it('refuses until the shadow has started and finished, and says so', async () => {
      await c.stockSettings.setLedgerMode(companyId, false);
      await c.stockShadow.setShadow(companyId, false);
      expect(await code(cutover.switchToLedger(companyId, 'admin-1'))).toBe('SHADOW_NOT_STARTED');
      await c.stockShadow.setShadow(companyId, true);
      expect(await code(cutover.switchToLedger(companyId, 'admin-1'))).toBe('SHADOW_NOT_DONE');
      expect((await cutover.status(companyId)).mode).toBe('shadow');
    });

    it('changes nothing when the two sides differ, but keeps the check that found it', async () => {
      await dayBefore();
      const p = await legacyProduct(3);
      const order = await place(p, 1);
      expect(await code(cutoverWith(dirty()).switchToLedger(companyId, 'admin-1'))).toBe('SHADOW_DIFFERS');
      const s = await cutover.status(companyId);
      expect(s.mode).toBe('shadow');
      expect(s.lastRun).toMatchObject({ trigger: 'cutover', ok: false });
      // The conversion was part of the step that failed, so it did not happen either.
      expect(await holds(order)).toEqual([]);
    });

    it('gives an order reserved the old way its hold, and then it settles the new way: paid, the stock leaves; cancelled, it goes back', async () => {
      await dayBefore();
      const [a, b] = [await legacyProduct(10), await legacyProduct(8)];
      const paid = await place(a, 3);
      const cancelled = await place(b, 2);
      expect(await counters(a)).toMatchObject({ s: 10, r: 3 });
      expect(await holds(paid)).toEqual([]);
      await finishBackfill();
      const done = await cutoverWith(scoped()).switchToLedger(companyId, 'admin-1');
      expect(done.converted).toBeGreaterThanOrEqual(2);
      expect(await cutover.status(companyId)).toMatchObject({ mode: 'ledger', lastRun: { trigger: 'cutover', ok: true, ranBy: 'admin-1' } });
      const hold = (await holds(paid))[0];
      expect(hold).toMatchObject({ productId: a, locationId: main, quantity: 3, state: 'held', purpose: 'order_line' });
      expect(hold?.sourcing).toMatchObject({ rule: 'migrated_from_counters' });
      expect(await balance(a)).toEqual({ onHand: 10, reserved: 3 });
      expect((await c.stockShadow.compare({ productIds: [a, b], holds: true })).reservationsDiffer).toBe(0);

      await Reservations.fulfilOrder(paid);
      expect(await balance(a)).toEqual({ onHand: 7, reserved: 0 });
      expect(await counters(a)).toMatchObject({ s: 7, r: 0 });
      await Reservations.releaseOrder(cancelled, 'payment failed');
      expect(await balance(b)).toEqual({ onHand: 8, reserved: 0 });
      expect(await counters(b)).toMatchObject({ s: 8, r: 0 });
      expect((await c.stockShadow.compare({ productIds: [a, b], holds: true, journal: true })).sample).toEqual([]);
    });

    it('does not make a promise twice', async () => {
      await dayBefore();
      const p = await legacyProduct(5);
      const order = await place(p, 2);
      await finishBackfill();
      await cutoverWith(scoped()).switchToLedger(companyId, 'admin-1');
      expect(await holds(order)).toHaveLength(1);
      expect(await c.stockShadow.convertLegacyHolds(db, companyId, main)).toBe(0);
      expect(await holds(order)).toHaveLength(1);
    });

    it('is not confused by sales going on around it: whichever side of the switch a sale lands on, both sides agree afterwards', async () => {
      await dayBefore();
      const p = await legacyProduct(50);
      await finishBackfill();
      const results = await Promise.allSettled([
        cutoverWith(scoped()).switchToLedger(companyId, 'admin-1'),
        oldWay(p, -2, 'order_fulfillment'),
        oldWay(p, -3, 'order_fulfillment'),
        oldWay(p, 4, 'manual_adjustment'),
      ]);
      expect(results.every((r) => r.status === 'fulfilled'), JSON.stringify(results.map((r) => (r.status === 'rejected' ? String(r.reason) : 'ok')))).toBe(true);
      expect((await cutover.status(companyId)).mode).toBe('ledger');
      expect(await counters(p)).toMatchObject({ s: 49 });
      expect(await balance(p)).toMatchObject({ onHand: 49 });
      expect((await c.stockShadow.compare({ productIds: [p], holds: true, journal: true })).sample).toEqual([]);
    });
  });

  describe('going back', () => {
    it('needs a reason, and is refused while the ledger holds promises for orders, saying how many', async () => {
      await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      const p = await legacyProduct(0);
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: main, type: 'receipt', quantity: 5, actor: { type: 'job' } }));
      const order = await place(p, 2);
      expect(await code(cutover.rollback(companyId, 'admin-1', ' '))).toBe('REASON_NEEDED');
      const problem = await cutover.rollback(companyId, 'admin-1', 'a problem').catch((e: unknown) => e as Error);
      expect(problem).toMatchObject({ code: 'OPEN_WORK' });
      expect((problem as Error).message).toMatch(/stock holds? for orders/);
      expect((await cutover.status(companyId)).mode).toBe('ledger');
      await Reservations.releaseOrder(order, 'test');
    });

    it('works when nothing is open: the old way carries on, with the old counters as they were left, and the history says why', async () => {
      await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      const open = await cutover.status(companyId);
      if (open.open.holds > 0 || open.open.transfersOnTheWay > 0) {
        // Left by other files in the shared database: settle them so the rule can be seen to allow going back.
        await db.update(schema.stockReservations).set({ state: 'released', released: 0 }).where(inArray(schema.stockReservations.state, ['held', 'partly_consumed']));
        await db.update(schema.stockDocuments).set({ state: 'closed' }).where(inArray(schema.stockDocuments.state, ['shipped', 'partly_received']));
      }
      await cutover.rollback(companyId, 'admin-1', 'Back to the old way while we look at a report');
      const s = await cutover.status(companyId);
      expect(s.mode).toBe('off');
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, companyId), eq(schema.decisionLog.action, 'stock.ledger.switched_off')));
      expect(log.at(-1)).toMatchObject({ reasonText: 'Back to the old way while we look at a report', actorId: 'admin-1', fromState: 'ledger', toState: 'off' });
      expect(await code(cutover.rollback(companyId, 'admin-1', 'again'))).toBe('NOT_ON');
    });
  });

  describe('the nightly check', () => {
    it('does nothing in the old way, and in the new ledger keeps its result', async () => {
      await c.stockSettings.setLedgerMode(companyId, false);
      await c.stockShadow.setShadow(companyId, false);
      const log: string[] = [];
      const helpers = { logger: { info: (m: string) => log.push(m), error: (m: string) => log.push(`ERROR ${m}`) } } as never;
      const before = (await cutover.status(companyId)).lastRun?.at;
      await tasks.stockShadowCheck({}, helpers);
      expect((await cutover.status(companyId)).lastRun?.at).toBe(before);
      await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      await tasks.stockShadowCheck({}, helpers);
      const after = (await cutover.status(companyId)).lastRun;
      expect(after).toMatchObject({ trigger: 'nightly', ranBy: null });
      expect(after?.at).not.toBe(before);
      await c.stockSettings.setLedgerMode(companyId, false);
    });
  });

});
