import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { has } from '@/lib/values';
import { MAX_DELIVERY_ATTEMPTS } from '@/lib/delivery-document';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as DocumentActions from './document-actions';
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
 * The delivery document, against a real database: an order split into deliveries without ever carrying more than it has, each step
 * checked and kept in the delivery's own history and on the order's timeline, a short pick left open, a part delivery that is not the
 * order delivered, failed attempts, returns and cancels, a version check, the permissions, and what the database itself refuses.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const PIN = { latitude: -1.2921, longitude: 36.8219 };

describe.skipIf(!has(url))('deliveries of an order (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof DocumentActions;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let OrderStages: typeof OrderStagesType;
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
  const order = async (over: { pay?: boolean; quantities?: [number, number]; wholeUnits?: boolean; method?: 'own_fleet' | 'courier' | 'pickup'; unplanned?: boolean } = {}) => {
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
      // An order taken by staff, or converted from a quote, comes with its branch and no delivery plan.
      ...(over.unplanned === true ? { branchId } : { delivery: method === 'pickup' ? { method, pickupBranchId: branchId } : { method, pin: PIN } }),
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
  const orderStatus = async (orderId: string) => (await db.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, orderId)))[0]?.status;

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
    if (madeBranches.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, madeBranches));
    if (madeLocations.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations));
  });

  describe('making a delivery', () => {
    it('carries everything the order has left by default, numbers it from the series, and starts as a draft with a history', async () => {
      const o = await order();
      const id = await made(o);
      const d = await view(id);
      expect(d).toMatchObject({ status: 'draft', method: 'own_fleet', branch: { id: o.branchId }, orderNumber: o.number, version: 1 });
      expect(d.number).toMatch(/^DLV-/);
      expect(d.lines.map((l) => [l.productId, l.quantity]).sort()).toEqual([[o.a, 5], [o.b, 2]].sort());
      expect(d.events.map((e) => e.action)).toEqual(['created']);
      expect(d.destination.pin).toEqual(PIN);
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, id));
      expect(log.map((l) => l.action)).toContain('delivery.document_created');
    });

    it('splits an order into deliveries and never carries more than the order has, however they are asked for', async () => {
      const o = await order();
      await made(o, [{ productId: o.a, quantity: 3 }]);
      const second = await c.deliveryDocuments.create(staff(), o.id, { lines: [{ productId: o.a, quantity: 3 }] });
      expect(second).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('Only 2 is left') as string });
      const rest = await c.deliveryDocuments.create(staff(), o.id, { lines: null });
      expect(rest.ok).toBe(true);
      if (rest.ok) expect((await view(rest.data.id)).lines.map((l) => [l.productId, l.quantity]).sort()).toEqual([[o.a, 2], [o.b, 2]].sort());
      expect(await c.deliveryDocuments.create(staff(), o.id, { lines: null })).toMatchObject({ ok: false, reason: 'nothing_left' });
      const status = await c.deliveryDocuments.forOrder(companyId, o.id);
      expect(status?.lines.every((l) => l.open === 0)).toBe(true);
      expect(status?.deliveries).toHaveLength(2);
    });

    it('refuses a product that is not on the order, a repeat, a quantity that is not positive, and one the unit cannot count', async () => {
      const o = await order({ wholeUnits: true });
      const ask = (lines: { productId: string; quantity: number }[]) => c.deliveryDocuments.create(staff(), o.id, { lines });
      expect(await ask([{ productId: 'prod_other', quantity: 1 }])).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await ask([{ productId: o.a, quantity: 1 }, { productId: o.a, quantity: 1 }])).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await ask([{ productId: o.a, quantity: 0 }])).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await ask([{ productId: o.a, quantity: -2 }])).toMatchObject({ ok: false, reason: 'bad_input' });
      if (wholeUnitId !== null) expect(await ask([{ productId: o.a, quantity: 1.5 }])).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('whole number') as string });
    });

    it('is made for an order that has a delivery to make, not for one that is collected, nor for one that was cancelled', async () => {
      const collected = await order({ method: 'pickup' });
      expect(await c.deliveryDocuments.create(staff(), collected.id, { lines: null })).toMatchObject({ ok: false, reason: 'wrong_method', message: expect.stringContaining('collected from a branch') as string });
      expect(await c.deliveryDocuments.create(staff(), randomUUID(), { lines: null })).toMatchObject({ ok: false, reason: 'not_found' });
      const cancelled = await order();
      await OrderStages.move(db, cancelled.id, 'cancelled', 'cancelled', { reasonCode: 'cancelled', message: 'test' });
      expect(await c.deliveryDocuments.create(staff(), cancelled.id, { lines: null })).toMatchObject({ ok: false, reason: 'order_not_ready' });
      expect((await c.deliveryDocuments.forOrder(companyId, collected.id))?.eligible).toMatchObject({ ok: false });
    });

    it('is made once for the goods when two people ask at the same moment', async () => {
      const o = await order();
      const results = await Promise.all([c.deliveryDocuments.create(staff(), o.id, { lines: null }), c.deliveryDocuments.create({ ...staff(), userId: 'dispatcher-2' }, o.id, { lines: null })]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toMatchObject([{ reason: 'nothing_left' }]);
    });
  });

  describe('the steps', () => {
    it('refuses a step out of order, in words, and keeps the state', async () => {
      const o = await order();
      const id = await made(o);
      expect(await c.deliveryDocuments.dispatch(staff(), id, {})).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('draft') as string });
      expect(await c.deliveryDocuments.markReady(staff(), id)).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect((await view(id)).status).toBe('draft');
    });

    it('will not release an unpaid order, and releases it once it is paid', async () => {
      const o = await order({ pay: false });
      const id = await made(o);
      expect(await c.deliveryDocuments.release(staff(), id)).toMatchObject({ ok: false, reason: 'order_not_ready', message: expect.stringContaining('not been paid') as string });
      await OrderStages.move(db, o.id, 'payment_confirmed', 'succeeded', {});
      expect(await c.deliveryDocuments.release(staff(), id)).toMatchObject({ ok: true, data: { status: 'released' } });
    });

    it('takes a delivery to delivered, with its history, the timeline of the order, and the order delivered only when all of it is', async () => {
      const o = await order();
      const id = await made(o);
      await toReady(id);
      expect((await view(id)).status).toBe('ready');
      expect(await c.deliveryDocuments.deliver(staff(), id, { receivedBy: 'Mama Wanjiku' })).toMatchObject({ ok: false, reason: 'not_allowed' });
      await goOut(id);
      expect(await orderStatus(o.id)).toBe('shipped');
      expect(await c.deliveryDocuments.deliver(staff(), id, {})).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('who received') as string });
      const done = await c.deliveryDocuments.deliver(staff(), id, { receivedBy: 'Mama Wanjiku' });
      expect(done).toMatchObject({ ok: true, data: { status: 'delivered', receivedBy: 'Mama Wanjiku' } });
      if (done.ok) {
        expect(done.data.lines.every((l) => l.delivered === l.quantity)).toBe(true);
        expect(done.data.events.map((e) => e.action)).toEqual(['created', 'release', 'start_picking', 'record_picked', 'mark_packed', 'mark_ready', 'dispatch', 'deliver']);
        expect(done.data.events.every((e) => e.actorId === 'dispatcher-1' && e.occurredAt !== '')).toBe(true);
      }
      expect(await orderStatus(o.id)).toBe('delivered');
      const stages = (await stagesOf(o.id)).map((s) => s.stage);
      for (const stage of ['released_for_fulfilment', 'pick_started', 'picked', 'packed', 'ready', 'dispatched', 'out_for_delivery', 'delivered']) expect(stages, stage).toContain(stage);
      expect((await c.deliveryDocuments.forOrder(companyId, o.id))?.state).toBe('delivered');
    });

    it('leaves a short pick open on the order, and a part delivery is not the order delivered', async () => {
      const o = await order();
      const first = await made(o);
      await toReady(first, [{ productId: o.a, quantity: 3 }, { productId: o.b, quantity: 2 }]);
      const afterPick = await c.deliveryDocuments.forOrder(companyId, o.id);
      expect(afterPick?.lines.find((l) => l.productId === o.a)).toMatchObject({ ordered: 5, committed: 3, open: 2 });
      await goOut(first);
      expect(await c.deliveryDocuments.deliver(staff(), first, { receivedBy: 'Gate guard' })).toMatchObject({ ok: true, data: { status: 'delivered' } });
      // Three of five of one product arrived: the order is not delivered, and says so.
      expect(await orderStatus(o.id)).toBe('shipped');
      expect((await stagesOf(o.id)).map((s) => s.stage)).toContain('part_delivered');
      expect((await stagesOf(o.id)).map((s) => s.stage)).not.toContain('delivered');
      expect((await c.deliveryDocuments.forOrder(companyId, o.id))?.state).toBe('partly_delivered');
      // The rest goes on another delivery, and then the order is delivered.
      const second = await made(o);
      expect((await view(second)).lines).toMatchObject([{ productId: o.a, quantity: 2 }]);
      await toReady(second);
      await goOut(second);
      await c.deliveryDocuments.deliver(staff(), second, { receivedBy: 'Gate guard' });
      expect(await orderStatus(o.id)).toBe('delivered');
      expect((await stagesOf(o.id)).map((s) => s.stage)).toContain('delivered');
    });

    it('will not mark packed what has not been counted, and refuses a count that is more than planned, missing, or nothing at all', async () => {
      const o = await order();
      const id = await made(o);
      await c.deliveryDocuments.release(staff(), id);
      await c.deliveryDocuments.startPicking(staff(), id);
      expect(await c.deliveryDocuments.markPacked(staff(), id)).toMatchObject({ ok: false, message: expect.stringContaining('Record what was picked') as string });
      expect(await c.deliveryDocuments.recordPicked(staff(), id, { picked: [{ productId: o.a, quantity: 9 }, { productId: o.b, quantity: 2 }] })).toMatchObject({ ok: false, message: expect.stringContaining('More was picked') as string });
      expect(await c.deliveryDocuments.recordPicked(staff(), id, { picked: [{ productId: o.a, quantity: 5 }] })).toMatchObject({ ok: false, message: expect.stringContaining('every product') as string });
      expect(await c.deliveryDocuments.recordPicked(staff(), id, { picked: [{ productId: o.a, quantity: 0 }, { productId: o.b, quantity: 0 }] })).toMatchObject({ ok: false, message: expect.stringContaining('Nothing was picked') as string });
      expect(await c.deliveryDocuments.recordPicked(staff(), id, { picked: 'lots' })).toMatchObject({ ok: false });
      // A count can be corrected until it is packed.
      await c.deliveryDocuments.recordPicked(staff(), id, { picked: [{ productId: o.a, quantity: 4 }, { productId: o.b, quantity: 2 }] });
      expect(await c.deliveryDocuments.recordPicked(staff(), id, { picked: [{ productId: o.a, quantity: 5 }, { productId: o.b, quantity: 2 }] })).toMatchObject({ ok: true });
    });

    it('is told to reload when someone else changed the delivery first', async () => {
      const o = await order();
      const id = await made(o);
      const seen = (await view(id)).version;
      expect(await c.deliveryDocuments.release(staff(), id, seen)).toMatchObject({ ok: true });
      expect(await c.deliveryDocuments.startPicking({ ...staff(), userId: 'dispatcher-2' }, id, seen)).toMatchObject({ ok: false, reason: 'conflict' });
      expect((await view(id)).status).toBe('released');
    });

    it('does each step once when two people press it at the same moment', async () => {
      const o = await order();
      const id = await made(o);
      const results = await Promise.all([c.deliveryDocuments.release(staff(), id), c.deliveryDocuments.release({ ...staff(), userId: 'dispatcher-2' }, id)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await view(id)).events.filter((e) => e.action === 'release')).toHaveLength(1);
    });
  });

  describe('a courier, a failed attempt, a return and a cancel', () => {
    it('needs the courier named before a courier delivery goes out, and keeps the tracking number', async () => {
      const o = await order({ method: 'courier' });
      const id = await made(o);
      await toReady(id);
      expect(await c.deliveryDocuments.dispatch(staff(), id, {})).toMatchObject({ ok: false, message: expect.stringContaining('which courier') as string });
      expect(await c.deliveryDocuments.dispatch(staff(), id, { courierName: 'Swift Couriers', trackingNumber: 'SW-12345' })).toMatchObject({ ok: true, data: { courierName: 'Swift Couriers', trackingNumber: 'SW-12345', status: 'out_for_delivery' } });
    });

    it('records a failed attempt with a reason from the list, shown on the order’s timeline, and allows another try only a few times', async () => {
      const o = await order();
      const id = await made(o);
      await toReady(id);
      for (let attempt = 1; attempt <= MAX_DELIVERY_ATTEMPTS; attempt += 1) {
        await goOut(id);
        expect(await c.deliveryDocuments.failAttempt(staff(), id, { reasonCode: 'made_up' })).toMatchObject({ ok: false, reason: 'bad_input' });
        expect(await c.deliveryDocuments.failAttempt(staff(), id, { reasonCode: 'other' })).toMatchObject({ ok: false, message: expect.stringContaining('Say what happened') as string });
        const failed = await c.deliveryDocuments.failAttempt(staff(), id, { reasonCode: 'customer_absent', note: 'Phone was off' });
        expect(failed).toMatchObject({ ok: true, data: { status: 'failed_attempt', failedAttempts: attempt } });
        if (attempt < MAX_DELIVERY_ATTEMPTS) expect(await c.deliveryDocuments.reattempt(staff(), id, { note: 'Called, will be home' })).toMatchObject({ ok: true, data: { status: 'ready' } });
      }
      expect(await c.deliveryDocuments.reattempt(staff(), id, {})).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('tried') as string });
      const attempts = (await stagesOf(o.id)).filter((s) => s.stage === 'delivery_attempted');
      expect(attempts).toHaveLength(MAX_DELIVERY_ATTEMPTS);
      expect(attempts.every((s) => s.outcome === 'failed' && s.reason === 'customer_absent')).toBe(true);
    });

    it('returns a delivery with a reason, and what it carried is open on the order again; a returned delivery stays returned', async () => {
      const o = await order();
      const id = await made(o);
      await toReady(id);
      await goOut(id);
      await c.deliveryDocuments.failAttempt(staff(), id, { reasonCode: 'refused' });
      expect(await c.deliveryDocuments.returnToStock(staff(), id, { reason: 'no' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryDocuments.returnToStock(staff(), id, { reason: 'The customer refused it at the door' })).toMatchObject({ ok: true, data: { status: 'returned' } });
      const left = await c.deliveryDocuments.forOrder(companyId, o.id);
      expect(left?.lines.every((l) => l.open === l.ordered)).toBe(true);
      expect(left?.state).toBe('not_started');
      expect((await stagesOf(o.id)).map((s) => s.stage)).toContain('delivery_failed');
      expect(await c.deliveryDocuments.reattempt(staff(), id, {})).toMatchObject({ ok: false, reason: 'not_allowed' });
      await expect(db.update(schema.deliveries).set({ status: 'ready' }).where(eq(schema.deliveries.id, id))).rejects.toThrow();
      expect((await c.deliveryDocuments.create(staff(), o.id, { lines: null })).ok).toBe(true);
    });

    it('cancels before it goes out, with a reason, and not after', async () => {
      const o = await order();
      const id = await made(o);
      expect(await c.deliveryDocuments.cancel(staff(), id, { reason: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryDocuments.cancel(staff(), id, { reason: 'Customer asked us to wait' })).toMatchObject({ ok: true, data: { status: 'cancelled' } });
      expect((await c.deliveryDocuments.forOrder(companyId, o.id))?.lines.every((l) => l.open === l.ordered)).toBe(true);
      const other = await order();
      const gone = await made(other);
      await toReady(gone);
      await goOut(gone);
      expect(await c.deliveryDocuments.cancel(staff(), gone, { reason: 'Changed our minds' })).toMatchObject({ ok: false, reason: 'not_allowed' });
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, id), eq(schema.decisionLog.action, 'delivery.cancel')));
      expect(log[0]).toMatchObject({ reasonText: 'Customer asked us to wait' });
    });

    it('plans the delivery of an order taken by staff, from its own branch and for the charge already on it, and then it is delivered like any other', async () => {
      const o = await order({ unplanned: true });
      // Before: it has no plan, so no delivery can be made, and the overview says staff can plan it, starting from the order's own address.
      expect(await c.deliveryDocuments.create(staff(), o.id, { lines: null })).toMatchObject({ ok: false, reason: 'not_found', message: expect.stringContaining('no delivery to make') as string });
      expect(await c.deliveryDocuments.forOrder(companyId, o.id)).toMatchObject({ eligible: { ok: false, needsPlan: true }, prefill: { town: 'Nairobi', county: 'Nairobi', street: '1 Test Rd' } });
      // Refused in words: nothing chosen, nowhere to go, half a receiver, an order that is not this company's or does not exist.
      const plan = (input: Record<string, unknown>) => c.orderDeliveries.planStaffOrder(staff(), o.id, input as Parameters<typeof c.orderDeliveries.planStaffOrder>[2]);
      expect(await plan({ method: 'drone', town: 'Nairobi' })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('how it is delivered') as string });
      expect(await plan({ method: 'own_fleet' })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('town or area') as string });
      expect(await plan({ method: 'own_fleet', town: 'Nairobi', recipientName: 'Mama Wanjiku' })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('both the name and the phone') as string });
      expect(await c.orderDeliveries.planStaffOrder(staff(), randomUUID(), { method: 'own_fleet', town: 'Nairobi' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.orderDeliveries.forOrder(companyId, o.id)).toBeNull();
      // Planned: the record carries the order's branch, its charge as it stands, the words and the receiver; the decision log says who and why.
      const done = await plan({ method: 'own_fleet', county: 'Nairobi', town: 'Nairobi', area: 'Westlands', recipientName: 'Mama Wanjiku', recipientPhone: '0722 111 222', notes: 'Blue gate' });
      expect(done).toMatchObject({ ok: true });
      const [taken] = await db.select({ fee: schema.orders.shippingFee }).from(schema.orders).where(eq(schema.orders.id, o.id));
      expect(await c.orderDeliveries.forOrder(companyId, o.id)).toMatchObject({ method: 'own_fleet', branchId: o.branchId, chargeAmount: Number(taken?.fee ?? 0).toFixed(2), chargeTax: '0.00', recipientName: 'Mama Wanjiku', notes: 'Blue gate', destination: { pin: null, address: { town: 'Nairobi', area: 'Westlands' }, positionFrom: 'none' }, choice: { reason: 'staff_chose' } });
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, o.id), eq(schema.decisionLog.action, 'delivery.planned_by_staff')));
      expect(log).toHaveLength(1);
      // Only once: a second plan is refused and changes nothing.
      expect(await plan({ method: 'courier', town: 'Mombasa' })).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('already has its delivery planned') as string });
      expect((await c.orderDeliveries.forOrder(companyId, o.id))?.method).toBe('own_fleet');
      // And now it is delivered like any other: a delivery can be made, to the receiver and the words given, and the street is the order's.
      const id = await made(o);
      expect(await view(id)).toMatchObject({ recipientName: 'Mama Wanjiku', notes: 'Blue gate', street: '1 Test Rd', destination: { address: { area: 'Westlands' } } });
      expect(await c.deliveryDocuments.forOrder(companyId, o.id)).toMatchObject({ eligible: { ok: true }, prefill: null });
    });

    it('puts a pin on a delivery that has only words, moves it and takes it off, until it goes out, and leaves everything else about it as it was', async () => {
      const o = await order({ unplanned: true });
      expect(await c.orderDeliveries.planStaffOrder(staff(), o.id, { method: 'own_fleet', town: 'Nairobi', area: 'Westlands' })).toMatchObject({ ok: true });
      const id = await made(o);
      expect((await view(id)).destination).toMatchObject({ pin: null, positionFrom: 'none', address: { area: 'Westlands' } });
      // Left out, the pin is untouched; a place that is not on the earth, or not a place, is refused in words and nothing else in the save is kept.
      expect(await c.deliveryDocuments.amend(staff(), id, { notes: 'Ring twice' })).toMatchObject({ ok: true, data: { destination: { pin: null } } });
      expect(await c.deliveryDocuments.amend(staff(), id, { pin: { latitude: 95, longitude: 36.8 }, notes: 'Not kept' })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('not a place on the earth') as string });
      expect(await c.deliveryDocuments.amend(staff(), id, { pin: 'near the baobab', notes: 'Not kept' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect((await view(id)).notes).toBe('Ring twice');
      // Put on: the destination now has the pin and says the position is from it; the words and the charge are as they were.
      const before = await c.orderDeliveries.forOrder(companyId, o.id);
      const put = await c.deliveryDocuments.amend(staff(), id, { pin: { latitude: -1.2921, longitude: 36.8219 } });
      expect(put).toMatchObject({ ok: true, data: { destination: { pin: { latitude: -1.2921, longitude: 36.8219 }, positionFrom: 'pin', approximate: false, address: { area: 'Westlands' } } } });
      expect(await c.orderDeliveries.forOrder(companyId, o.id)).toEqual(before);
      // Moved, then taken off (null), and the history says from where to where.
      expect(await c.deliveryDocuments.amend(staff(), id, { pin: { latitude: -1.3, longitude: 36.78 } })).toMatchObject({ ok: true, data: { destination: { pin: { latitude: -1.3, longitude: 36.78 } } } });
      expect(await c.deliveryDocuments.amend(staff(), id, { pin: null })).toMatchObject({ ok: true, data: { destination: { pin: null, positionFrom: 'none' } } });
      const events = await db.select().from(schema.deliveryEvents).where(eq(schema.deliveryEvents.deliveryId, id));
      const moves = events.filter((e) => e.action === 'amend' && 'pinTo' in (e.detail as object)).map((e) => e.detail as { pinFrom: unknown; pinTo: unknown });
      expect(moves).toEqual([{ pinFrom: null, pinTo: { latitude: -1.2921, longitude: 36.8219 } }, { pinFrom: { latitude: -1.2921, longitude: 36.8219 }, pinTo: { latitude: -1.3, longitude: 36.78 } }, { pinFrom: { latitude: -1.3, longitude: 36.78 }, pinTo: null }].map((m) => expect.objectContaining(m) as unknown));
      // The same place again says nothing in the history; after it goes out it cannot be changed.
      await c.deliveryDocuments.amend(staff(), id, { pin: { latitude: -1.2921, longitude: 36.8219 } });
      await c.deliveryDocuments.amend(staff(), id, { pin: { latitude: -1.2921, longitude: 36.8219 } });
      await toReady(id);
      await goOut(id);
      expect(await c.deliveryDocuments.amend(staff(), id, { pin: null })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });

    it('does not offer to plan an order that is cancelled', async () => {
      const o = await order({ unplanned: true });
      await db.update(schema.orders).set({ status: 'cancelled' }).where(eq(schema.orders.id, o.id));
      expect(await c.deliveryDocuments.forOrder(companyId, o.id)).toMatchObject({ eligible: { ok: false, reason: expect.stringContaining('cancelled') as string } });
      expect(await c.orderDeliveries.planStaffOrder(staff(), o.id, { method: 'own_fleet', town: 'Nairobi' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });

    it('corrects the street the order was written with, and nothing else about where it goes, until it goes out', async () => {
      const o = await order();
      const id = await made(o);
      const addressOf = async () => (await db.select({ a: schema.orders.shippingAddress }).from(schema.orders).where(eq(schema.orders.id, o.id)))[0]?.a;
      // The street is shown with the delivery, as the rider and the courier are given it.
      expect(await c.deliveryDocuments.get(companyId, id)).toMatchObject({ street: '1 Test Rd' });
      // Left out, it is left alone; too short, it is refused in words and nothing else changes.
      expect(await c.deliveryDocuments.amend(staff(), id, { notes: 'Ring twice' })).toMatchObject({ ok: true, data: { street: '1 Test Rd', notes: 'Ring twice' } });
      expect(await c.deliveryDocuments.amend(staff(), id, { street: ' x ', notes: 'Should not be kept' })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('street or building') as string });
      expect((await c.deliveryDocuments.get(companyId, id))?.notes).toBe('Ring twice');
      // Corrected: the order carries it, the town and country are untouched, the place and charge are not recalculated, and the history says from what to what.
      const before = (await c.deliveryDocuments.get(companyId, id))?.destination;
      expect(await c.deliveryDocuments.amend(staff(), id, { street: '  14B Test Rd, Gate 2 ' })).toMatchObject({ ok: true, data: { street: '14B Test Rd, Gate 2' } });
      expect(await addressOf()).toMatchObject({ street: '14B Test Rd, Gate 2', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' });
      expect((await c.deliveryDocuments.get(companyId, id))?.destination).toEqual(before);
      const events = await db.select().from(schema.deliveryEvents).where(eq(schema.deliveryEvents.deliveryId, id));
      expect(events.some((e) => e.action === 'amend' && (e.detail as { streetFrom?: string; streetTo?: string }).streetFrom === '1 Test Rd' && (e.detail as { streetTo?: string }).streetTo === '14B Test Rd, Gate 2')).toBe(true);
      // The same street again changes nothing in the history's detail; after it goes out it cannot be changed.
      await toReady(id);
      await goOut(id);
      expect(await c.deliveryDocuments.amend(staff(), id, { street: 'Somewhere else' })).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect((await addressOf())?.street).toBe('14B Test Rd, Gate 2');
    });

    it('changes who receives it, and the note, until it goes out and not after', async () => {
      const o = await order();
      const id = await made(o);
      expect(await c.deliveryDocuments.amend(staff(), id, { recipientName: 'Mama Wanjiku', recipientPhone: '0722 111 222', notes: 'Blue gate' })).toMatchObject({ ok: true, data: { recipientName: 'Mama Wanjiku', notes: 'Blue gate' } });
      await toReady(id);
      await goOut(id);
      expect(await c.deliveryDocuments.amend(staff(), id, { recipientName: 'Someone else' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });
  });

  describe('what is kept, and who may', () => {
    it('keeps every event: it cannot be changed or removed, even straight in the database', async () => {
      const o = await order();
      const id = await made(o);
      await expect(db.update(schema.deliveryEvents).set({ note: 'changed' }).where(eq(schema.deliveryEvents.deliveryId, id))).rejects.toThrow();
      await expect(db.delete(schema.deliveryEvents).where(eq(schema.deliveryEvents.deliveryId, id))).rejects.toThrow();
    });

    it('is enforced by the database too: no line over its plan, no more delivered than picked, no delivered state without a time', async () => {
      const o = await order();
      const id = await made(o);
      await expect(db.update(schema.deliveryLines).set({ picked: '99' }).where(eq(schema.deliveryLines.deliveryId, id))).rejects.toThrow();
      await expect(db.update(schema.deliveryLines).set({ delivered: '99' }).where(eq(schema.deliveryLines.deliveryId, id))).rejects.toThrow();
      await expect(db.update(schema.deliveries).set({ status: 'delivered' }).where(eq(schema.deliveries.id, id))).rejects.toThrow();
      await expect(db.update(schema.deliveries).set({ status: 'nonsense' as never }).where(eq(schema.deliveries.id, id))).rejects.toThrow();
    });

    it('keeps one company’s deliveries out of reach of another', async () => {
      const o = await order();
      const id = await made(o);
      const stranger = { companyId: randomUUID(), userId: 'dispatcher-9' };
      expect(await c.deliveryDocuments.get(stranger.companyId, id)).toBeNull();
      expect(await c.deliveryDocuments.release(stranger, id)).toMatchObject({ ok: false, reason: 'not_found' });
      expect((await c.deliveryDocuments.list(stranger.companyId, {})).rows).toEqual([]);
      expect(await c.deliveryDocuments.create(stranger, o.id, { lines: null })).toMatchObject({ ok: false });
    });

    it('lists the newest first, by state and by what is typed, a page at a time without repeating or missing one', async () => {
      const o = await order();
      const own = await made(o);
      const [row] = await db.select().from(schema.deliveries).where(eq(schema.deliveries.id, own));
      if (row === undefined) throw new Error('no row');
      const many = Array.from({ length: 27 }, (_, i) => ({ ...row, id: randomUUID(), number: `LIST-${tag}-${String(i).padStart(3, '0')}`, createdAt: new Date(Date.now() + 1000 + i) }));
      await db.insert(schema.deliveries).values(many);
      const first = await c.deliveryDocuments.list(companyId, { query: `LIST-${tag}` });
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      expect(first.rows[0]?.number).toBe(`LIST-${tag}-026`);
      const second = await c.deliveryDocuments.list(companyId, { query: `LIST-${tag}`, cursor: first.nextCursor });
      expect(second.rows.map((i) => i.number)).toEqual([`LIST-${tag}-001`, `LIST-${tag}-000`]);
      expect(second.nextCursor).toBeNull();
      expect(new Set([...first.rows, ...second.rows].map((i) => i.id)).size).toBe(27);
      const byState = await c.deliveryDocuments.list(companyId, { status: 'cancelled', query: `LIST-${tag}` });
      expect(byState.rows).toEqual([]);
      expect((await c.deliveryDocuments.list(companyId, { query: row.number })).rows.map((i) => i.id)).toContain(own);
      expect((await c.deliveryDocuments.list(companyId, { query: o.number })).rows.length).toBeGreaterThan(0);
      expect((await c.deliveryDocuments.list(companyId, { query: '%' })).rows.every((i) => i.number.includes('%') || i.orderNumber.includes('%') || i.customerName.includes('%'))).toBe(true);
    });

    it('lets only people allowed to fulfil deliveries take a step, and people allowed to read see them', async () => {
      const o = await order();
      const id = await made(o);
      requirePermission.mockImplementation((permission: string) => (permission === 'deliveries:read' ? Promise.resolve('reader-1') : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedError' }))));
      expect((await actions.deliveryAction(id)).ok).toBe(true);
      expect((await actions.deliveriesPageAction({})).ok).toBe(true);
      expect((await actions.orderDeliveriesAction(o.id)).ok).toBe(true);
      expect((await actions.deliveryStepAction({ deliveryId: id, step: 'release' })).ok).toBe(false);
      expect((await actions.createDeliveryAction({ orderId: o.id })).ok).toBe(false);
      expect((await view(id)).status).toBe('draft');
      requirePermission.mockResolvedValue('dispatcher-1');
      expect(await actions.deliveryStepAction({ deliveryId: id, step: 'release' })).toMatchObject({ ok: true, data: { status: 'released' } });
      expect(await actions.deliveryStepAction({ deliveryId: id, step: 'teleport' })).toMatchObject({ ok: false });
      expect(await actions.deliveryStepAction({ deliveryId: '', step: 'release' })).toMatchObject({ ok: false });
      expect(await actions.deliveryAction('nope')).toMatchObject({ ok: false });
    });
  });
});
