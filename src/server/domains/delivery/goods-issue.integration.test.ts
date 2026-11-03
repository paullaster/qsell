import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as DocumentActions from './document-actions';
import type { InventoryReservationService as ReservationType } from '@/server/domains/inventory/reservation-service';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import type { OrderStages as OrderStagesType } from '@/server/domains/orders/stages';
import { holdLedgerSwitch, settleFinanceBacklog } from '@/server/domains/stock/test-support';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers({ 'x-real-ip': '10.1.2.9' })) }));
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }));

/**
 * When the stock of a delivered order leaves the shelf, against a real database: at payment as always, or part by part as each
 * delivery goes out or arrives; a paid order's hold that does not lapse; a collected order that is still issued at payment; and the
 * receipt of goods that come back (counted back, written off, or kept), once for each product, with its stage on the timeline.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const PIN = { latitude: -1.2921, longitude: 36.8219 };

describe.skipIf(!has(url))('stock issued with deliveries (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof DocumentActions;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let OrderStages: typeof OrderStagesType;
  let fulfilOrder: (typeof ReservationType)['fulfilOrder'];
  let companyId: string;
  let releaseLedgerSwitch: (() => Promise<void>) | undefined;
  let itemTypeId: string;
  let wholeUnitId: string | null;
  let spy: { mockRestore: () => void } | undefined;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  let n = 0;
  const code = () => `DD${tag}${String((n += 1)).padStart(3, '0')}`;
  const madeBranches: string[] = [];
  const madeLocations: string[] = [];

  const staff = () => ({ companyId, userId: 'dispatcher-1' });

  const product = async (over: { wholeUnits?: boolean } = {}) => {
    const id = `prod_dd_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `DD-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `DDS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Delivered ${id.slice(-6)}`, slug: `dd-${randomUUID()}`, itemTypeId, price: '1000', costPrice: '10', taxRate: '0', isTaxInclusive: false, stockQuantity: 0, ...(over.wholeUnits === true && wholeUnitId !== null ? { baseUnitId: wholeUnitId } : {}) });
    return id;
  };

  /** A placed, paid order of two products (5 and 2), delivered by the shop's own riders from a branch that holds them. */
  const order = async (over: { pay?: boolean; quantities?: [number, number]; wholeUnits?: boolean; method?: 'own_fleet' | 'courier' | 'pickup' } = {}) => {
    const method = over.method ?? 'own_fleet';
    const [b] = await db.insert(schema.branches).values({ companyId, code: code(), name: `Branch ${code()}`, latitude: PIN.latitude, longitude: PIN.longitude }).returning();
    const branchId = b?.id ?? '';
    madeBranches.push(branchId);
    await db.insert(schema.deliveryMethods).values({ companyId, branchId, method });
    const [qa, qb] = over.quantities ?? [5, 2];
    const a = await product({ wholeUnits: over.wholeUnits });
    const bProduct = await product({ wholeUnits: over.wholeUnits });
    const loc = await c.stockLocations.create(companyId, { code: code(), name: 'Shelf', kind: 'store', branchId, fulfilsDelivery: true });
    madeLocations.push(loc.id);
    for (const p of [a, bProduct]) await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: loc.id, type: 'receipt', quantity: 50, unitCost: 10, actor: { type: 'job' } }));
    const policies = await import('./policy-actions');
    const made = await policies.createChargePolicyDraftAction(code(), { name: 'Flat', method: 'flat', currency: 'KES', scopes: { branch: { op: 'in', values: [branchId] } }, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 300 }], taxRate: 0 });
    if (!made.ok) throw new Error(made.error);
    const live = await policies.activateChargePolicyAction(made.data.id, 'Set up for the test');
    if (!live.ok) throw new Error(live.error);
    const r = await createOrder({
      orderNumber: `DD-${randomUUID()}`, customerName: 'Delivered Buyer', customerEmail: `dd-${randomUUID()}@deliver.test`, customerPhone: '0700000000',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId: a, quantity: qa }, { productId: bProduct, quantity: qb }], currency: 'KES', paymentMethod: 'mpesa_daraja',
      delivery: method === 'pickup' ? { method, pickupBranchId: branchId } : { method, pin: PIN },
    });
    if (!r.success || r.order === undefined) throw new Error(r.error);
    if (over.pay !== false) await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    return { id: r.order.id, number: r.order.orderNumber, a, b: bProduct, branchId };
  };

  const made = async (o: Awaited<ReturnType<typeof order>>, lines?: { productId: string; quantity: number }[]) => {
    const r = await c.deliveryDocuments.create(staff(), o.id, { lines: lines ?? null });
    if (!r.ok) throw new Error(r.message);
    return r.data.id;
  };
  const view = async (id: string) => {
    const v = await c.deliveryDocuments.get(companyId, id);
    if (v === null) throw new Error('no such delivery');
    return v;
  };
  const toReady = async (id: string, picked?: { productId: string; quantity: number }[]) => {
    const d = c.deliveryDocuments;
    const steps = [() => d.release(staff(), id), () => d.startPicking(staff(), id)];
    for (const s of steps) {
      const r = await s();
      if (!r.ok) throw new Error(r.message);
    }
    const lines = (await view(id)).lines.map((l) => ({ productId: l.productId, quantity: picked?.find((p) => p.productId === l.productId)?.quantity ?? l.quantity }));
    for (const s of [() => d.recordPicked(staff(), id, { picked: lines }), () => d.markPacked(staff(), id), () => d.markReady(staff(), id)]) {
      const r = await s();
      if (!r.ok) throw new Error(r.message);
    }
  };
  const goOut = async (id: string) => {
    const r = await c.deliveryDocuments.dispatch(staff(), id, {});
    if (!r.ok) throw new Error(r.message);
  };
  const stagesOf = async (orderId: string) => (await db.select({ stage: schema.orderStageEvents.stage, outcome: schema.orderStageEvents.outcome, reason: schema.orderStageEvents.reasonCode }).from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, orderId)).orderBy(schema.orderStageEvents.sequence));

  beforeAll(async () => {
    // Files that switch stock-by-location for the whole company take turns, so none confuses another.
    releaseLedgerSwitch = await holdLedgerSwitch(url);
    // An order that is collected has a code, sealed with the instance's data-encryption key.
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./document-actions');
    ({ OrderStages } = await import('@/server/domains/orders/stages'));
    fulfilOrder = (await import('@/server/domains/inventory/reservation-service')).InventoryReservationService.fulfilOrder.bind((await import('@/server/domains/inventory/reservation-service')).InventoryReservationService);
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Deliveries Test Co');
    itemTypeId = `it_dd_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const [whole] = await db.select({ id: schema.unitsOfMeasure.id }).from(schema.unitsOfMeasure).where(eq(schema.unitsOfMeasure.decimals, 0)).limit(1);
    wholeUnitId = whole?.id ?? null;
    await c.stockLocations.ensureDefault(companyId);
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  }, 900_000);
  // Registered first, so it runs last: the switch is given back only after this file has put everything right.
  afterAll(async () => {
    await releaseLedgerSwitch?.();
  }, 60_000);
  afterAll(async () => {
    spy?.mockRestore();
    await c.stockSettings.setIssueMoment(companyId, 'payment');
    await c.stockSettings.setLedgerMode(companyId, false);
    const rest = await db.select({ id: schema.chargePolicies.id }).from(schema.chargePolicies).where(like(schema.chargePolicies.code, `DD${tag}%`));
    if (rest.length > 0) {
      await db.delete(schema.chargePolicyRates).where(inArray(schema.chargePolicyRates.policyId, rest.map((r) => r.id)));
      await db.delete(schema.chargePolicies).where(inArray(schema.chargePolicies.id, rest.map((r) => r.id)));
    }
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('dispatcher-1');
  });
  afterEach(async () => {
    await c.stockSettings.setIssueMoment(companyId, 'payment');
    if (madeBranches.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, madeBranches));
    if (madeLocations.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations));
  });


  const onHand = async (productId: string) => Number((await db.select({ t: sql<string>`COALESCE(sum(${schema.stockBalances.onHand}), 0)` }).from(schema.stockBalances).where(eq(schema.stockBalances.productId, productId)))[0]?.t ?? 0);
  const moves = async (productId: string, type: string) => await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.productId, productId), eq(schema.stockMovements.movementType, type)));
  const holdsOf = async (orderId: string, productId: string) => await db.select().from(schema.stockReservations).where(and(eq(schema.stockReservations.refId, orderId), eq(schema.stockReservations.productId, productId)));
  const on = (moment: 'payment' | 'dispatch' | 'delivery') => c.stockSettings.setIssueMoment(companyId, moment);
  const runTo = async (id: string, picked?: { productId: string; quantity: number }[]) => {
    await toReady(id, picked);
    await goOut(id);
  };
  const arrive = async (id: string) => {
    const r = await c.deliveryDocuments.deliver(staff(), id, { receivedBy: 'Mama Wanjiku' });
    if (!r.ok) throw new Error(r.message);
  };
  const sendBack = async (id: string) => {
    const f = await c.deliveryDocuments.failAttempt(staff(), id, { reasonCode: 'customer_absent' });
    if (!f.ok) throw new Error(f.message);
    const r = await c.deliveryDocuments.returnToStock(staff(), id, { reason: 'Customer is away for a week' });
    if (!r.ok) throw new Error(r.message);
  };

  describe('when the stock leaves', () => {
    it('is at payment unless the shop chooses otherwise: the whole order leaves when it is paid, and the deliveries issue nothing', async () => {
      const o = await order();
      await fulfilOrder(o.id);
      expect(await onHand(o.a)).toBe(45);
      expect(await onHand(o.b)).toBe(48);
      const id = await made(o);
      await runTo(id);
      await arrive(id);
      expect(await onHand(o.a)).toBe(45);
      expect((await view(id)).lines.every((l) => l.issued === 0)).toBe(true);
    });

    it('leaves a delivered order held when it is paid, and issues each delivery as it goes out, part by part', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      expect(await onHand(o.a)).toBe(50);
      expect((await holdsOf(o.id, o.a)).map((h) => h.state)).toEqual(['held']);

      const first = await made(o, [{ productId: o.a, quantity: 3 }]);
      await toReady(first);
      expect(await onHand(o.a)).toBe(50);
      await goOut(first);
      expect(await onHand(o.a)).toBe(47);
      expect(await onHand(o.b)).toBe(50);
      expect((await view(first)).lines[0]?.issued).toBe(3);
      expect((await holdsOf(o.id, o.a)).map((h) => h.state)).toEqual(['partly_consumed']);
      const stages = await stagesOf(o.id);
      expect(stages.filter((s) => s.stage === 'stock_issued')).toHaveLength(1);

      const rest = await made(o);
      await runTo(rest);
      expect(await onHand(o.a)).toBe(45);
      expect(await onHand(o.b)).toBe(48);
      expect((await holdsOf(o.id, o.a)).map((h) => h.state)).toEqual(['consumed']);
      expect((await view(rest)).lines.map((l) => l.issued).sort()).toEqual([2, 2]);
      expect((await stagesOf(o.id)).filter((s) => s.stage === 'stock_issued')).toHaveLength(2);
      // The old journal has one line for the product, with both parts in it.
      const journal = await db.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.referenceId, o.id), eq(schema.inventoryMovements.productId, o.a), eq(schema.inventoryMovements.changeType, 'order_fulfillment')));
      expect(journal.map((j) => j.changeAmount)).toEqual([-5]);
      // The line still says, in its before and after figures, what the goods that left came to.
      expect(journal.map((j) => j.newStock - j.previousStock)).toEqual([-5]);
    });

    it('issues only what was picked when a pick is short, and the difference stays held for another delivery', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id, [{ productId: o.a, quantity: 4 }]);
      expect(await onHand(o.a)).toBe(46);
      const [hold] = await holdsOf(o.id, o.a);
      expect(hold?.state).toBe('partly_consumed');
      const more = await made(o);
      expect((await view(more)).lines.find((l) => l.productId === o.a)?.quantity).toBe(1);
      await runTo(more);
      expect(await onHand(o.a)).toBe(45);
    });

    it('issues as a delivery arrives when the shop chooses that, and not as it goes out', async () => {
      await on('delivery');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      expect(await onHand(o.a)).toBe(50);
      await arrive(id);
      expect(await onHand(o.a)).toBe(45);
      expect(await onHand(o.b)).toBe(48);
      expect((await stagesOf(o.id)).filter((s) => s.stage === 'stock_issued')).toHaveLength(1);
    });

    it('keeps the hold of a paid order from lapsing, and puts back what it still holds when the order is cancelled', async () => {
      await on('dispatch');
      const o = await order({ pay: false });
      await db.update(schema.stockReservations).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.stockReservations.refId, o.id));
      await fulfilOrder(o.id);
      expect((await holdsOf(o.id, o.a)).every((h) => h.expiresAt === null && h.state === 'held')).toBe(true);
      const lapsed = await c.stockReservations.expireDue(companyId, new Date(), 500);
      expect(lapsed.some((l) => l.refId === o.id)).toBe(false);
      await c.stockReservations.release({ companyId, refType: 'order', refId: o.id, actor: 'test', reason: 'cancelled' });
      expect(await onHand(o.a)).toBe(50);
    });

    it('still issues a collected order when it is paid, and an order paid before the change keeps what it had', async () => {
      const early = await order();
      await fulfilOrder(early.id);
      await on('dispatch');
      const collected = await order({ method: 'pickup' });
      await fulfilOrder(collected.id);
      expect(await onHand(collected.a)).toBe(45);
      // Paid before the change: nothing is held, so the delivery issues nothing a second time.
      const id = await made(early);
      await runTo(id);
      expect(await onHand(early.a)).toBe(45);
      expect((await view(id)).lines.every((l) => l.issued === 0)).toBe(true);
    });
  });

  describe('the setting', () => {
    it('is refused until stock is kept by location, and for a word that is not a moment; it is logged and applies at once', async () => {
      expect(await c.stockSettings.setIssueMoment(companyId, 'dispatch')).toBe('dispatch');
      expect((await c.stockSettings.get()).issueMoment).toBe('dispatch');
      await expect(c.stockSettings.setIssueMoment(companyId, 'whenever')).rejects.toMatchObject({ code: 'BAD_MOMENT' });
      await c.stockSettings.setLedgerMode(companyId, false);
      try {
        await expect(c.stockSettings.setIssueMoment(companyId, 'delivery')).rejects.toMatchObject({ code: 'NEEDS_LEDGER' });
        // While the counters are the truth, the setting is not used whatever it says.
        expect((await c.stockSettings.get()).issueMoment).toBe('payment');
      } finally {
        await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      }
    });

    it('is changed through the action only by someone allowed, and the change is in the decision log', async () => {
      const set = await actions.setStockTimingAction({ moment: 'dispatch' });
      expect(set).toMatchObject({ ok: true, data: { moment: 'dispatch' } });
      expect(requirePermission).toHaveBeenCalledWith('stock:cutover');
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, companyId), eq(schema.decisionLog.action, 'stock.issue_moment')));
      expect(log.length).toBeGreaterThan(0);
      expect(await actions.setStockTimingAction({ moment: 'nonsense' })).toMatchObject({ ok: false });
      requirePermission.mockImplementation((p: string) => (p === 'deliveries:read' ? Promise.resolve('reader-1') : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedError' }))));
      expect(await actions.setStockTimingAction({ moment: 'payment' })).toMatchObject({ ok: false });
      const seen = await actions.stockTimingAction();
      expect(seen).toMatchObject({ ok: true, data: { moment: 'dispatch', byLocation: true, canChange: false } });
    });
  });

  describe('goods that come back', () => {
    it('are counted back onto the shelf where they were held when the shop issued them at dispatch, once for each product', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      expect(await onHand(o.a)).toBe(45);
      await sendBack(id);
      const v = await view(id);
      expect(v.status).toBe('returned');
      expect(v.lines.find((l) => l.productId === o.a)?.back).toMatchObject({ could: 5, receipt: null, choices: [{ id: 'return_to_stock' }, { id: 'quarantine' }, { id: 'scrap' }] });

      const r = await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 4, disposition: 'return_to_stock' }], note: 'One torn open' });
      expect(r.ok).toBe(true);
      expect(await onHand(o.a)).toBe(49);
      expect((await moves(o.a, 'sale_return')).map((m) => m.quantity)).toEqual([4]);
      expect((await stagesOf(o.id)).filter((s) => s.stage === 'returned_to_stock')).toHaveLength(1);
      const after = await view(id);
      expect(after.lines.find((l) => l.productId === o.a)?.back?.receipt).toMatchObject({ quantity: 4, disposition: 'return_to_stock' });
      expect(after.events.map((e) => e.action)).toContain('receive_return');
      // A product is received once; the other one can still be.
      expect(await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 1, disposition: 'return_to_stock' }] })).toMatchObject({ ok: false, reason: 'conflict' });
      expect((await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.b, quantity: 2, disposition: 'return_to_stock' }] })).ok).toBe(true);
      expect(await onHand(o.b)).toBe(50);
      // The goods are open on the order again, and going out again issues them again from the shelf.
      const again = await made(o);
      await runTo(again);
      expect(await onHand(o.b)).toBe(48);
    });

    it('can be counted back and written off when spoilt, so the sale is undone and the loss is recorded', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      const r = await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 2, disposition: 'scrap' }] });
      expect(r.ok).toBe(true);
      // Counted back and written off at once: the shelf is where the issue left it, and both movements are on record.
      expect(await onHand(o.a)).toBe(45);
      expect((await moves(o.a, 'sale_return')).map((m) => m.quantity)).toEqual([2]);
      expect((await moves(o.a, 'write_off')).map((m) => m.quantity)).toEqual([-2]);
      expect((await stagesOf(o.id)).filter((s) => s.stage === 'returned_to_stock')).toHaveLength(0);
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, id), eq(schema.decisionLog.action, 'delivery.return_set_aside')));
      expect(log).toHaveLength(1);
    });

    it('need nothing when the shop issues on arrival and they were never issued, unless spoilt, which writes them off the books', async () => {
      await on('delivery');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      expect(await onHand(o.a)).toBe(50);
      const choices = (await view(id)).lines.find((l) => l.productId === o.a)?.back?.choices.map((c0) => c0.id);
      expect(choices).toEqual(['return_to_stock', 'quarantine', 'scrap']);
      expect((await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 1, disposition: 'scrap' }, { productId: o.b, quantity: 2, disposition: 'return_to_stock' }] })).ok).toBe(true);
      expect(await onHand(o.a)).toBe(49);
      expect(await onHand(o.b)).toBe(50);
      expect(await moves(o.b, 'sale_return')).toHaveLength(0);
    });

    it('are refused, and nothing is received, when spoilt goods cannot be replaced from the shelf for the order that is still owed them', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      const place = (await holdsOf(o.id, o.a))[0]?.locationId ?? '';
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: o.a, locationId: place, type: 'write_off', quantity: -45, actor: { type: 'job' } }));
      const r = await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 5, disposition: 'scrap' }] });
      expect(r).toMatchObject({ ok: false, reason: 'conflict', message: expect.stringContaining('not enough stock') as string });
      expect(await onHand(o.a)).toBe(0);
      expect((await view(id)).lines.find((l) => l.productId === o.a)?.back?.receipt).toBeNull();
      expect(await db.select().from(schema.deliveryReturns).where(eq(schema.deliveryReturns.deliveryId, id))).toHaveLength(0);
    });

    it('can be counted into a quarantine place, never sold from there, while the order is held a replacement from the shelf', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      const q = await c.stockLocations.create(companyId, { code: code(), name: 'Look at these', kind: 'quarantine', isSellable: false });
      madeLocations.push(q.id);
      expect((await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 2, disposition: 'quarantine' }] })).ok).toBe(true);
      const back = await moves(o.a, 'sale_return');
      expect(back.map((m) => [m.locationId, m.quantity])).toEqual([[q.id, 2]]);
      const available = await c.stockAvailability.forProduct(o.a, 'ecommerce');
      expect(available.onHand).toBe(45);
      expect((await holdsOf(o.id, o.a)).filter((h) => h.state === 'held').reduce((n, h) => n + h.quantity, 0)).toBe(2);
    });

    it('is refused in words when there is no quarantine place to count the goods into', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      const active = await db.select({ id: schema.stockLocations.id }).from(schema.stockLocations).where(and(eq(schema.stockLocations.companyId, companyId), eq(schema.stockLocations.kind, 'quarantine'), eq(schema.stockLocations.isActive, true)));
      if (active.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, active.map((a) => a.id)));
      try {
        const r = await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 1, disposition: 'quarantine' }] });
        expect(r).toMatchObject({ ok: false, reason: 'conflict', message: expect.stringContaining('quarantine place') as string });
        expect(await onHand(o.a)).toBe(45);
      } finally {
        if (active.length > 0) await db.update(schema.stockLocations).set({ isActive: true }).where(inArray(schema.stockLocations.id, active.map((a) => a.id)));
      }
    });

    it('does not count the same goods twice in the old settlement journal when they go out again after coming back', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      expect((await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 5, disposition: 'return_to_stock' }, { productId: o.b, quantity: 2, disposition: 'return_to_stock' }] })).ok).toBe(true);
      const journal = async () => (await db.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.referenceId, o.id), eq(schema.inventoryMovements.productId, o.a), eq(schema.inventoryMovements.changeType, 'order_fulfillment')))).map((j) => j.changeAmount);
      expect(await journal()).toEqual([0]);
      await runTo(await made(o));
      expect(await journal()).toEqual([-5]);
      expect(await onHand(o.a)).toBe(45);
      const [line] = await db.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.referenceId, o.id), eq(schema.inventoryMovements.productId, o.a), eq(schema.inventoryMovements.changeType, 'order_fulfillment')));
      expect((line?.newStock ?? 0) - (line?.previousStock ?? 0)).toBe(-5);
    });

    it('can be corrected: what the receipt did is undone and the corrected receipt done, kept as a new revision with its reason', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      expect((await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 5, disposition: 'return_to_stock' }] })).ok).toBe(true);
      expect(await onHand(o.a)).toBe(50);

      const fixed = await c.deliveryDocuments.correctReturn(staff(), id, { productId: o.a, quantity: 3, disposition: 'scrap', reason: 'Two were fine, three were crushed' });
      expect(fixed.ok).toBe(true);
      // Five were counted back, then the receipt was undone (45), then three were counted back and written off (45).
      expect(await onHand(o.a)).toBe(45);
      const line = (await view(id)).lines.find((l) => l.productId === o.a);
      expect(line?.back?.receipt).toMatchObject({ revision: 2, quantity: 3, disposition: 'scrap', correctionReason: 'Two were fine, three were crushed', correctable: true });
      expect(line?.back?.earlier).toMatchObject([{ revision: 1, quantity: 5 }]);
      expect((await view(id)).events.map((e) => e.action)).toContain('correct_return');
      const held = (await holdsOf(o.id, o.a)).filter((h) => h.state === 'held').reduce((n, h) => n + h.quantity, 0);
      expect(held).toBe(3);
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, id), eq(schema.decisionLog.action, 'delivery.return_corrected')));
      expect(log).toHaveLength(1);
      // Both receipts are kept, and the second can be corrected again.
      expect(await db.select().from(schema.deliveryReturns).where(and(eq(schema.deliveryReturns.deliveryId, id), eq(schema.deliveryReturns.productId, o.a)))).toHaveLength(2);
      expect((await c.deliveryDocuments.correctReturn(staff(), id, { productId: o.a, quantity: 5, disposition: 'return_to_stock', reason: 'They were all fine after all' })).ok).toBe(true);
      expect(await onHand(o.a)).toBe(50);
    });

    it('cannot be corrected once the goods have gone out again, and a correction needs a reason, a received product and a choice that fits', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      const ask = (over: Record<string, unknown>) => c.deliveryDocuments.correctReturn(staff(), id, { productId: o.a, quantity: 5, disposition: 'scrap', reason: 'Counted wrongly', ...over });
      expect(await ask({})).toMatchObject({ ok: false, reason: 'not_found' });
      expect((await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 5, disposition: 'return_to_stock' }] })).ok).toBe(true);
      expect(await ask({ reason: 'no' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await ask({ quantity: 9 })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await ask({ disposition: 'keep' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await ask({ productId: 'prod_other' })).toMatchObject({ ok: false });
      expect(await c.deliveryDocuments.correctReturn({ companyId: randomUUID(), userId: 'x' }, id, { productId: o.a, quantity: 5, disposition: 'scrap', reason: 'Counted wrongly' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await onHand(o.a)).toBe(50);

      await runTo(await made(o));
      expect(await onHand(o.a)).toBe(45);
      expect((await view(id)).lines.find((l) => l.productId === o.a)?.back?.receipt?.correctable).toBe(false);
      expect(await ask({})).toMatchObject({ ok: false, reason: 'conflict', message: expect.stringContaining('gone out again') as string });
      expect(await onHand(o.a)).toBe(45);
    });

    it('is corrected through the step action only by someone who may fulfil deliveries', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      expect((await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 5, disposition: 'return_to_stock' }] })).ok).toBe(true);
      const body = { deliveryId: id, step: 'correct_return', productId: o.a, quantity: 4, disposition: 'scrap', reason: 'One was missing' };
      requirePermission.mockImplementation((p: string) => (p === 'deliveries:read' ? Promise.resolve('reader-1') : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedError' }))));
      expect(await actions.deliveryStepAction(body)).toMatchObject({ ok: false });
      requirePermission.mockResolvedValue('dispatcher-1');
      expect(await actions.deliveryStepAction(body)).toMatchObject({ ok: true });
    });

    it('are kept for the order when the stock was issued at payment, and nothing else is offered', async () => {
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      const line = (await view(id)).lines[0];
      expect(line?.back?.choices.map((c0) => c0.id)).toEqual(['keep']);
      expect(await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 1, disposition: 'return_to_stock' }] })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect((await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 5, disposition: 'keep' }] })).ok).toBe(true);
      expect(await onHand(o.a)).toBe(45);
    });

    it('are refused in words: for a delivery that has not been returned, too many, none, an unknown product, a bad choice', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      expect(await c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 1, disposition: 'return_to_stock' }] })).toMatchObject({ ok: false, reason: 'not_allowed' });
      await runTo(id);
      await sendBack(id);
      const ask = (lines: unknown) => c.deliveryDocuments.receiveReturn(staff(), id, { lines });
      expect(await ask([])).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('what came back') as string });
      expect(await ask([{ productId: o.a, quantity: 9, disposition: 'return_to_stock' }])).toMatchObject({ ok: false, message: expect.stringContaining('No more than 5') as string });
      expect(await ask([{ productId: 'prod_other', quantity: 1, disposition: 'return_to_stock' }])).toMatchObject({ ok: false });
      expect(await ask([{ productId: o.a, quantity: 1, disposition: 'sell_it' }])).toMatchObject({ ok: false });
      expect(await ask('not a list')).toMatchObject({ ok: false });
      expect(await c.deliveryDocuments.receiveReturn({ companyId: randomUUID(), userId: 'x' }, id, { lines: [{ productId: o.a, quantity: 1, disposition: 'return_to_stock' }] })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await onHand(o.a)).toBe(45);
    });

    it('cannot be changed once received, even straight in the database, and two people receiving at once receive once', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      const results = await Promise.all([1, 2].map(() => c.deliveryDocuments.receiveReturn(staff(), id, { lines: [{ productId: o.a, quantity: 5, disposition: 'return_to_stock' }] })));
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(await onHand(o.a)).toBe(50);
      await expect(db.update(schema.deliveryReturns).set({ quantity: '1' }).where(eq(schema.deliveryReturns.deliveryId, id))).rejects.toThrow();
      await expect(db.delete(schema.deliveryReturns).where(eq(schema.deliveryReturns.deliveryId, id))).rejects.toThrow();
    });

    it('go through the step action only for someone who may fulfil deliveries', async () => {
      await on('dispatch');
      const o = await order();
      await fulfilOrder(o.id);
      const id = await made(o);
      await runTo(id);
      await sendBack(id);
      requirePermission.mockImplementation((p: string) => (p === 'deliveries:read' ? Promise.resolve('reader-1') : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedError' }))));
      expect(await actions.deliveryStepAction({ deliveryId: id, step: 'receive_return', lines: [{ productId: o.a, quantity: 5, disposition: 'return_to_stock' }] })).toMatchObject({ ok: false });
      requirePermission.mockResolvedValue('dispatcher-1');
      expect(await actions.deliveryStepAction({ deliveryId: id, step: 'receive_return', lines: [{ productId: o.a, quantity: 5, disposition: 'return_to_stock' }] })).toMatchObject({ ok: true });
      expect(await onHand(o.a)).toBe(50);
    });
  });
});
