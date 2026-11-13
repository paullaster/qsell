import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as RunActions from './run-actions';
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
 * Runs and courier shipments, against a real database: deliveries put on a run and taken off, put in order, the whole run sent out
 * together or not at all, closed only when each delivery has a result, cancelled with a reason; the dispatch board; and what a courier
 * reports turned into the delivery's own steps.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const PIN = { latitude: -1.2921, longitude: 36.8219 };

describe.skipIf(!has(url))('runs and courier shipments (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let runActions: typeof RunActions;
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

  beforeAll(async () => {
    // Files that switch stock-by-location for the whole company take turns, so none confuses another.
    releaseLedgerSwitch = await holdLedgerSwitch(url);
    // An order that is collected has a code, sealed with the instance's data-encryption key.
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    runActions = await import('./run-actions');
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


  const arrive = async (id: string) => {
    const r = await c.deliveryDocuments.deliver(staff(), id, { receivedBy: 'Mama Wanjiku' });
    if (!r.ok) throw new Error(r.message);
  };

  const stagesOfOrder = async (orderId: string) => (await db.select({ stage: schema.orderStageEvents.stage }).from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, orderId))).map((r) => r.stage);
  const runStaff = () => ({ companyId, userId: 'dispatcher-1' });
  const today = () => new Date().toISOString().slice(0, 10);
  const newRun = async (branchId: string, over: Record<string, unknown> = {}) => {
    const r = await c.deliveryRuns.create(runStaff(), { branchId, runDate: today(), riderName: 'Otieno', vehicle: 'KMFA 123A', ...over });
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };
  const readyDelivery = async (o: Awaited<ReturnType<typeof order>>, lines?: { productId: string; quantity: number }[]) => {
    const id = await made(o, lines);
    await toReady(id);
    return id;
  };
  const runView = async (id: string) => {
    const v = await c.deliveryRuns.get(companyId, id);
    if (v === null) throw new Error('no such run');
    return v;
  };

  describe('making a run and putting deliveries on it', () => {
    it('is numbered from its series, starts planned and empty, and is in the decision log', async () => {
      const o = await order();
      const run = await newRun(o.branchId);
      expect(run.number).toMatch(/^RUN-/);
      const v = await runView(run.id);
      expect(v).toMatchObject({ status: 'planned', riderName: 'Otieno', vehicle: 'KMFA 123A', version: 1, editable: true, stops: [] });
      expect(v.actions.map((a) => a.action)).toEqual(['start', 'cancel']);
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, run.id), eq(schema.decisionLog.action, 'run.created')));
      expect(log).toHaveLength(1);
    });

    it('refuses a run without a rider, a day or a branch, and a branch that is not this company’s', async () => {
      const o = await order();
      expect(await c.deliveryRuns.create(runStaff(), { branchId: o.branchId, runDate: today(), riderName: '  ' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryRuns.create(runStaff(), { branchId: o.branchId, runDate: 'tomorrow', riderName: 'A' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryRuns.create(runStaff(), { runDate: today(), riderName: 'A' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryRuns.create(runStaff(), { branchId: randomUUID(), runDate: today(), riderName: 'A' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.deliveryRuns.create({ companyId: randomUUID(), userId: 'x' }, { branchId: o.branchId, runDate: today(), riderName: 'A' })).toMatchObject({ ok: false, reason: 'not_found' });
    });

    it('takes a ready delivery of its branch, in order, with units, value and weight, and each delivery on one run only', async () => {
      const o1 = await order();
      const d1 = await readyDelivery(o1);
      const run = await newRun(o1.branchId);
      const added = await c.deliveryRuns.addStop(runStaff(), run.id, d1);
      expect(added.ok).toBe(true);
      const v = await runView(run.id);
      expect(v.stops.map((s) => [s.deliveryId, s.sequence, s.units])).toEqual([[d1, 1, 7]]);
      expect(v.totals).toMatchObject({ stops: 1, units: 7 });
      expect(v.version).toBe(2);
      // On a run already: another run cannot take it, and the same run cannot take it twice.
      const other = await newRun(o1.branchId);
      expect(await c.deliveryRuns.addStop(runStaff(), other.id, d1)).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('already on a run') as string });
      expect(await c.deliveryRuns.addStop(runStaff(), run.id, d1)).toMatchObject({ ok: false });
      // It shows on the board no more.
      expect((await c.deliveryRuns.board(companyId, {}, new Date())).ready.some((r) => r.deliveryId === d1)).toBe(false);
    });

    it('refuses a delivery that is not ready, one from another branch, a courier delivery, and one that is not found', async () => {
      const o = await order();
      const run = await newRun(o.branchId);
      const draft = await made(o);
      expect(await c.deliveryRuns.addStop(runStaff(), run.id, draft)).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('ready to go') as string });
      const elsewhere = await order();
      expect(await c.deliveryRuns.addStop(runStaff(), run.id, await readyDelivery(elsewhere))).toMatchObject({ ok: false, message: expect.stringContaining('another branch') as string });
      const courier = await order({ method: 'courier' });
      expect(await c.deliveryRuns.addStop(runStaff(), (await newRun(courier.branchId)).id, await readyDelivery(courier))).toMatchObject({ ok: false, reason: 'wrong_method' });
      expect(await c.deliveryRuns.addStop(runStaff(), run.id, randomUUID())).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.deliveryRuns.addStop({ companyId: randomUUID(), userId: 'x' }, run.id, draft)).toMatchObject({ ok: false, reason: 'not_found' });
    });

    it('takes a delivery off (the others close up), puts the stops in order, and suggests the nearest next', async () => {
      const o = await order();
      const run = await newRun(o.branchId);
      const ids: string[] = [];
      for (let n = 0; n < 3; n += 1) {
        const id = await readyDelivery(o, [{ productId: o.a, quantity: 1 }]);
        ids.push(id);
        expect((await c.deliveryRuns.addStop(runStaff(), run.id, id)).ok).toBe(true);
      }
      expect((await runView(run.id)).stops.map((s) => s.deliveryId)).toEqual(ids);
      expect((await c.deliveryRuns.reorder(runStaff(), run.id, [ids[2], ids[0], ids[1]])).ok).toBe(true);
      expect((await runView(run.id)).stops.map((s) => s.deliveryId)).toEqual([ids[2], ids[0], ids[1]]);
      expect(await c.deliveryRuns.reorder(runStaff(), run.id, [ids[0], ids[1]])).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryRuns.reorder(runStaff(), run.id, [ids[0], ids[0], ids[1]])).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryRuns.reorder(runStaff(), run.id, 'nope')).toMatchObject({ ok: false, reason: 'bad_input' });
      expect((await c.deliveryRuns.arrange(runStaff(), run.id)).ok).toBe(true);
      expect((await c.deliveryRuns.removeStop(runStaff(), run.id, ids[0])).ok).toBe(true);
      expect((await runView(run.id)).stops.map((s) => s.sequence)).toEqual([1, 2]);
      expect(await c.deliveryRuns.removeStop(runStaff(), run.id, ids[0])).toMatchObject({ ok: false, reason: 'not_found' });
      // Taken off, it is free to join another run, and is back on the board.
      expect((await c.deliveryRuns.addStop(runStaff(), (await newRun(o.branchId)).id, ids[0])).ok).toBe(true);
    });

    it('refuses a stale version, so two dispatchers cannot overwrite each other', async () => {
      const o = await order();
      const run = await newRun(o.branchId);
      const d = await readyDelivery(o, [{ productId: o.a, quantity: 2 }]);
      expect((await c.deliveryRuns.addStop(runStaff(), run.id, d, 1)).ok).toBe(true);
      const d2 = await readyDelivery(o, [{ productId: o.a, quantity: 1 }]);
      expect(await c.deliveryRuns.addStop(runStaff(), run.id, d2, 1)).toMatchObject({ ok: false, reason: 'conflict' });
    });
  });

  describe('sending a run out and closing it', () => {
    it('sends every delivery out together, in one go, with the history naming the run, then closes once each has a result', async () => {
      const o = await order();
      const run = await newRun(o.branchId);
      const d1 = await readyDelivery(o, [{ productId: o.a, quantity: 2 }]);
      const d2 = await readyDelivery(o, [{ productId: o.a, quantity: 3 }]);
      for (const d of [d1, d2]) await c.deliveryRuns.addStop(runStaff(), run.id, d);
      const started = await c.deliveryRuns.start(runStaff(), run.id);
      expect(started.ok).toBe(true);
      expect((await runView(run.id))).toMatchObject({ status: 'started', editable: false });
      for (const d of [d1, d2]) {
        const v = await view(d);
        expect(v.status).toBe('out_for_delivery');
        const sent = v.events.find((e) => e.action === 'dispatch');
        expect(sent?.note).toContain('Otieno');
        expect(sent?.detail).toMatchObject({ rider: 'Otieno' });
      }
      // Cannot be closed while one is still out; the message says how many.
      expect(await c.deliveryRuns.complete(runStaff(), run.id)).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('2 deliveries are still out') as string });
      await arrive(d1);
      const failed = await c.deliveryDocuments.failAttempt(staff(), d2, { reasonCode: 'customer_absent' });
      expect(failed.ok).toBe(true);
      const closed = await c.deliveryRuns.complete(runStaff(), run.id);
      expect(closed.ok).toBe(true);
      expect(await runView(run.id)).toMatchObject({ status: 'completed' });
      // The one that did not get through left the run and can go on another.
      expect((await c.deliveryRuns.get(companyId, run.id))?.stops.map((s) => s.deliveryId)).toEqual([d1]);
      expect((await c.deliveryDocuments.reattempt(staff(), d2, { note: 'Customer will be home' })).ok).toBe(true);
      expect((await c.deliveryRuns.addStop(runStaff(), (await newRun(o.branchId)).id, d2)).ok).toBe(true);
    });

    it('goes out whole or not at all: one delivery refused (its order was cancelled) stops the run, and nothing has left', async () => {
      const paid = await order();
      const unpaid = await order();
      const good = await readyDelivery(paid);
      const bad = await readyDelivery(unpaid);
      // Its order is cancelled after the delivery was made ready, so it cannot go out.
      await OrderStages.move(db, unpaid.id, 'cancelled', 'succeeded', {});
      const run = await newRun(paid.branchId);
      // They are at different branches in this fixture, so make the second one ready at the run's branch.
      await db.update(schema.deliveries).set({ branchId: paid.branchId }).where(eq(schema.deliveries.id, bad));
      await c.deliveryRuns.addStop(runStaff(), run.id, good);
      expect((await c.deliveryRuns.addStop(runStaff(), run.id, bad)).ok).toBe(true);
      const started = await c.deliveryRuns.start(runStaff(), run.id);
      expect(started).toMatchObject({ ok: false, reason: 'order_not_ready', message: expect.stringContaining('Take it off the run') as string });
      expect((await view(good)).status).toBe('ready');
      expect((await view(bad)).status).toBe('ready');
      expect(await runView(run.id)).toMatchObject({ status: 'planned' });
      // Take the bad one off and it goes.
      expect((await c.deliveryRuns.removeStop(runStaff(), run.id, bad)).ok).toBe(true);
      expect((await c.deliveryRuns.start(runStaff(), run.id)).ok).toBe(true);
      expect((await view(good)).status).toBe('out_for_delivery');
    });

    it('cannot be started empty or twice, and a started run cannot be changed or cancelled', async () => {
      const o = await order();
      const run = await newRun(o.branchId);
      expect(await c.deliveryRuns.start(runStaff(), run.id)).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('at least one') as string });
      const d = await readyDelivery(o);
      await c.deliveryRuns.addStop(runStaff(), run.id, d);
      expect((await c.deliveryRuns.start(runStaff(), run.id)).ok).toBe(true);
      expect(await c.deliveryRuns.start(runStaff(), run.id)).toMatchObject({ ok: false });
      expect(await c.deliveryRuns.removeStop(runStaff(), run.id, d)).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(await c.deliveryRuns.cancel(runStaff(), run.id, { reason: 'Changed our minds' })).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(await c.deliveryRuns.complete(runStaff(), run.id, 1)).toMatchObject({ ok: false, reason: 'conflict' });
    });

    it('can be cancelled before it goes, with a reason, and its deliveries are free again', async () => {
      const o = await order();
      const run = await newRun(o.branchId);
      const d = await readyDelivery(o);
      await c.deliveryRuns.addStop(runStaff(), run.id, d);
      expect(await c.deliveryRuns.cancel(runStaff(), run.id, { reason: 'no' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect((await c.deliveryRuns.cancel(runStaff(), run.id, { reason: 'The rider is ill' })).ok).toBe(true);
      expect(await runView(run.id)).toMatchObject({ status: 'cancelled', stops: [] });
      expect((await c.deliveryRuns.addStop(runStaff(), (await newRun(o.branchId)).id, d)).ok).toBe(true);
    });

    it('is asked for only by someone who may use the dispatch board', async () => {
      const o = await order();
      requirePermission.mockImplementation((p: string) => (p === 'deliveries:read' ? Promise.resolve('reader-1') : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedError' }))));
      expect(await runActions.dispatchBoardAction()).toMatchObject({ ok: false });
      expect(await runActions.createRunAction({ branchId: o.branchId, runDate: today(), riderName: 'A' })).toMatchObject({ ok: false });
      expect(await runActions.runStepAction({ runId: randomUUID(), step: 'start' })).toMatchObject({ ok: false });
      requirePermission.mockResolvedValue('dispatcher-1');
      const made1 = await runActions.createRunAction({ branchId: o.branchId, runDate: today(), riderName: 'A' });
      expect(made1).toMatchObject({ ok: true });
      expect(await runActions.dispatchBoardAction({})).toMatchObject({ ok: true });
      expect(await runActions.runStepAction({ runId: made1.ok ? made1.data.id : '', step: 'nonsense' })).toMatchObject({ ok: false });
    });
  });

  describe('the dispatch board', () => {
    it('lists ready deliveries oldest first with how long they have waited, hides ones on a run, and the open runs with their stops', async () => {
      const o = await order();
      const d1 = await readyDelivery(o, [{ productId: o.a, quantity: 1 }]);
      const d2 = await readyDelivery(o, [{ productId: o.a, quantity: 1 }]);
      await db.update(schema.deliveries).set({ readyAt: new Date(Date.now() - 30 * 3_600_000) }).where(eq(schema.deliveries.id, d2));
      const run = await newRun(o.branchId);
      const board = await c.deliveryRuns.board(companyId, { branchId: o.branchId }, new Date());
      const ids = board.ready.map((r) => r.deliveryId);
      expect(ids.indexOf(d2)).toBeLessThan(ids.indexOf(d1));
      expect(board.ready.find((r) => r.deliveryId === d2)?.waiting).toMatchObject({ late: true });
      expect(board.ready.find((r) => r.deliveryId === d1)?.waiting).toMatchObject({ late: false });
      expect(board.runs.some((r) => r.id === run.id && r.status === 'planned')).toBe(true);
      await c.deliveryRuns.addStop(runStaff(), run.id, d1);
      const after = await c.deliveryRuns.board(companyId, { branchId: o.branchId }, new Date());
      expect(after.ready.some((r) => r.deliveryId === d1)).toBe(false);
      expect(after.runs.find((r) => r.id === run.id)?.stops).toBe(1);
    });

    it('lists runs a page at a time by state', async () => {
      const o = await order();
      const run = await newRun(o.branchId);
      const page = await c.deliveryRuns.list(companyId, { status: 'planned' });
      expect(page.rows.some((r) => r.id === run.id)).toBe(true);
      expect(page.rows.every((r) => r.status === 'planned')).toBe(true);
      for (let n = 0; n < 26; n += 1) await newRun(o.branchId);
      const first = await c.deliveryRuns.list(companyId, {});
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await c.deliveryRuns.list(companyId, { cursor: first.nextCursor });
      expect(second.rows.length).toBeGreaterThan(0);
      expect(new Set([...first.rows, ...second.rows].map((r) => r.id)).size).toBe(first.rows.length + second.rows.length);
    });
  });

  describe('a courier delivery', () => {
    const outWithCourier = async () => {
      const o = await order({ method: 'courier' });
      const id = await made(o);
      await toReady(id);
      const sent = await c.deliveryDocuments.dispatch(staff(), id, { courierName: 'Swift Couriers', trackingNumber: 'SW123' });
      if (!sent.ok) throw new Error(sent.message);
      return { o, id };
    };

    it('has its shipment recorded when it goes out, and appears on the board with the courier', async () => {
      const { o, id } = await outWithCourier();
      expect(await c.courierShipments.forDelivery(companyId, id)).toMatchObject({ courierName: 'Swift Couriers', trackingNumber: 'SW123', status: 'in_transit', adapter: 'manual' });
      const board = await c.deliveryRuns.board(companyId, { branchId: o.branchId }, new Date());
      expect(board.withCouriers.find((w) => w.deliveryId === id)).toMatchObject({ courierName: 'Swift Couriers', trackingNumber: 'SW123' });
    });

    it('takes the courier’s news: more tracking detail is noted, delivered completes the delivery, a problem is a failed attempt', async () => {
      const { o, id } = await outWithCourier();
      const note = await c.courierShipments.news(runStaff(), id, { state: 'in_transit', note: 'At the Nairobi hub', trackingNumber: 'SW123-B' });
      expect(note.ok).toBe(true);
      expect(await c.courierShipments.forDelivery(companyId, id)).toMatchObject({ trackingNumber: 'SW123-B', lastNote: 'At the Nairobi hub' });
      expect((await view(id)).events.map((e) => e.action)).toContain('courier_update');
      expect((await view(id)).status).toBe('out_for_delivery');

      expect(await c.courierShipments.news(runStaff(), id, { state: 'exception', note: '' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.courierShipments.news(runStaff(), id, { state: 'lost' })).toMatchObject({ ok: false, reason: 'bad_input' });
      const problem = await c.courierShipments.news(runStaff(), id, { state: 'exception', note: 'Recipient phone off', reasonCode: 'unreachable' });
      expect(problem.ok).toBe(true);
      expect((await view(id)).status).toBe('failed_attempt');
      expect(await c.courierShipments.forDelivery(companyId, id)).toMatchObject({ status: 'exception' });
      // A parcel that is not with the courier any more takes no more news.
      expect(await c.courierShipments.news(runStaff(), id, { state: 'delivered', receivedBy: 'X' })).toMatchObject({ ok: false, reason: 'not_allowed' });

      // Sent again, then delivered as the courier says.
      expect((await c.deliveryDocuments.reattempt(staff(), id, { note: 'New number' })).ok).toBe(true);
      expect((await c.deliveryDocuments.dispatch(staff(), id, { courierName: 'Swift Couriers', trackingNumber: 'SW999' })).ok).toBe(true);
      const done = await c.courierShipments.news(runStaff(), id, { state: 'delivered', receivedBy: 'Gate guard', note: 'Signed on the courier’s device' });
      expect(done.ok).toBe(true);
      expect((await view(id)).status).toBe('delivered');
      expect((await view(id)).receivedBy).toBe('Gate guard');
      expect(await c.courierShipments.forDelivery(companyId, id)).toMatchObject({ status: 'delivered' });
      expect((await stagesOfOrder(o.id)).filter((x) => x === 'delivered')).toHaveLength(1);
    });

    it('is not accepted for an own-fleet delivery, another company’s, or one that is not found, and needs the dispatch permission', async () => {
      const own = await order();
      const ownId = await made(own);
      expect(await c.courierShipments.news(runStaff(), ownId, { state: 'delivered', receivedBy: 'X' })).toMatchObject({ ok: false, reason: 'wrong_method' });
      const { id } = await outWithCourier();
      expect(await c.courierShipments.news({ companyId: randomUUID(), userId: 'x' }, id, { state: 'delivered', receivedBy: 'X' })).toMatchObject({ ok: false, reason: 'not_found' });
      requirePermission.mockImplementation((p: string) => (p === 'deliveries:read' ? Promise.resolve('reader-1') : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedError' }))));
      expect(await runActions.courierNewsAction({ deliveryId: id, state: 'delivered', receivedBy: 'X' })).toMatchObject({ ok: false });
      requirePermission.mockResolvedValue('dispatcher-1');
      expect(await runActions.deliveryExtrasAction(id)).toMatchObject({ ok: true, data: { shipment: { courierName: 'Swift Couriers' }, run: null } });
    });
  });
  describe('vehicles and what a run may carry', () => {
    const vehicle = async (name: string, limits: Record<string, unknown> = {}) => {
      const r = await c.deliveryVehicles.create(runStaff(), { name: `${name} ${code()}`, ...limits });
      if (!r.ok) throw new Error(r.message);
      return r.data;
    };
    /** An order split into two ready deliveries (5 of the first product and 2 of the second) from one branch, with weights of 2 kg and 3 kg a unit. */
    const twoParcels = async (weights: [number | null, number | null] = [2, 3]) => {
      const o = await order();
      for (const [p, w] of [[o.a, weights[0]], [o.b, weights[1]]] as const) await db.update(schema.products).set({ weight: w === null ? null : String(w) }).where(eq(schema.products.id, p));
      const first = await readyDelivery(o, [{ productId: o.a, quantity: 5 }]);
      const second = await readyDelivery(o, [{ productId: o.b, quantity: 2 }]);
      return { o, first, second };
    };

    it('keeps a register: names are unique whatever their case, limits make sense, edits use a version, and a vehicle is stopped, never removed', async () => {
      const v = await vehicle('Isuzu');
      expect(await c.deliveryVehicles.create(runStaff(), { name: v.name.toLowerCase() })).toMatchObject({ ok: false, reason: 'conflict' });
      for (const bad of [{ name: '' }, { name: 'X', maxWeightKg: 0 }, { name: 'X', maxStops: 1.5 }]) expect(await c.deliveryVehicles.create(runStaff(), bad)).toMatchObject({ ok: false, reason: 'bad_input' });
      const changed = await c.deliveryVehicles.update(runStaff(), v.id, { name: v.name, maxWeightKg: '150', maxStops: 6, expectedVersion: v.version });
      expect(changed).toMatchObject({ ok: true, data: { maxWeightKg: 150, maxStops: 6, version: v.version + 1 } });
      expect(await c.deliveryVehicles.update(runStaff(), v.id, { name: v.name, expectedVersion: v.version })).toMatchObject({ ok: false, reason: 'conflict' });
      const stopped = await c.deliveryVehicles.setActive(runStaff(), v.id, { isActive: false, expectedVersion: v.version + 1 });
      expect(stopped).toMatchObject({ ok: true, data: { isActive: false } });
      expect((await c.deliveryVehicles.list(companyId)).find((x) => x.id === v.id)).toMatchObject({ isActive: false, runsInUse: 0 });
      // Another company sees and changes nothing of it.
      const stranger = { companyId: randomUUID(), userId: 'x' };
      expect(await c.deliveryVehicles.setActive(stranger, v.id, { isActive: true, expectedVersion: v.version + 2 })).toMatchObject({ ok: false, reason: 'not_found' });
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, v.id), eq(schema.decisionLog.subjectType, 'delivery_vehicle')));
      expect(log.map((l) => l.action).sort()).toEqual(['vehicle.changed', 'vehicle.created', 'vehicle.stopped']);
    });

    it('gives a run a vehicle from the register, keeping its name; a stopped or unknown one is refused and a typed-in name still works', async () => {
      const o = await order();
      const v = await vehicle('Van');
      const run = await newRun(o.branchId, { vehicleId: v.id, vehicle: 'ignored' });
      expect(await runView(run.id)).toMatchObject({ vehicleId: v.id, vehicle: v.name, limits: { maxWeightKg: null, maxStops: null } });
      expect(await c.deliveryRuns.create(runStaff(), { branchId: o.branchId, runDate: today(), riderName: 'A', vehicleId: randomUUID() })).toMatchObject({ ok: false, reason: 'not_allowed' });
      await c.deliveryVehicles.setActive(runStaff(), v.id, { isActive: false, expectedVersion: v.version });
      expect(await c.deliveryRuns.create(runStaff(), { branchId: o.branchId, runDate: today(), riderName: 'A', vehicleId: v.id })).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('stopped') as string });
      const typed = await newRun(o.branchId, { vehicle: 'Borrowed pickup' });
      expect(await runView(typed.id)).toMatchObject({ vehicleId: null, vehicle: 'Borrowed pickup', limits: null });
      // The run in a stopped vehicle carries on, and the register counts it.
      expect((await c.deliveryVehicles.list(companyId)).find((x) => x.id === v.id)?.runsInUse).toBe(1);
    });

    it('refuses a delivery that would take a run over its vehicle\'s weight, says by how much, leaves the run as it was, and lets it go on another run', async () => {
      const { o, first, second } = await twoParcels();
      // 5 x 2 kg = 10 kg and 2 x 3 kg = 6 kg; this vehicle carries 12.
      const v = await vehicle('Small van', { maxWeightKg: 12 });
      const run = await newRun(o.branchId, { vehicleId: v.id });
      expect(await c.deliveryRuns.addStop(runStaff(), run.id, first)).toMatchObject({ ok: true });
      const refused = await c.deliveryRuns.addStop(runStaff(), run.id, second);
      expect(refused).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('carries at most 12 kg; this run would carry 16 kg') as string });
      const after = await runView(run.id);
      expect(after.totals).toMatchObject({ stops: 1, weightKg: 10 });
      expect(after.limits).toEqual({ maxWeightKg: 12, maxVolumeLitres: null, maxStops: null });
      const roomy = await vehicle('Big lorry', { maxWeightKg: 500 });
      const other = await newRun(o.branchId, { vehicleId: roomy.id });
      expect(await c.deliveryRuns.addStop(runStaff(), other.id, second)).toMatchObject({ ok: true });
    });

    it('refuses a delivery that would fill a run beyond its vehicle\'s space, counts goods with no size as nothing, shows the totals, and lets it go on a roomier vehicle', async () => {
      const { o, first, second } = await twoParcels([null, null]);
      // 5 x 40 litres = 200 litres and 2 x 150 litres = 300 litres; this vehicle holds 250.
      for (const [p, l] of [[o.a, '40'], [o.b, '150']] as const) await db.update(schema.products).set({ volumeLitres: l }).where(eq(schema.products.id, p));
      const small = await vehicle('Boot only', { maxVolumeLitres: 250 });
      const run = await newRun(o.branchId, { vehicleId: small.id });
      expect(await c.deliveryRuns.addStop(runStaff(), run.id, first)).toMatchObject({ ok: true });
      const refused = await c.deliveryRuns.addStop(runStaff(), run.id, second);
      expect(refused).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('holds at most 250 litres; this run would fill 500 litres') as string });
      const after = await runView(run.id);
      expect(after.totals).toMatchObject({ stops: 1, volumeLitres: 200, stopsWithoutVolume: 0 });
      expect(after.limits).toEqual({ maxWeightKg: null, maxVolumeLitres: 250, maxStops: null });
      const roomy = await vehicle('Box truck', { maxVolumeLitres: 5000 });
      const other = await newRun(o.branchId, { vehicleId: roomy.id });
      expect(await c.deliveryRuns.addStop(runStaff(), other.id, second)).toMatchObject({ ok: true });
      expect((await runView(other.id)).totals).toMatchObject({ stops: 1, volumeLitres: 300 });
      // Changing a planned run to the small vehicle is refused for the same reason, and goods with no size count as nothing.
      expect(await c.deliveryRuns.assignVehicle(runStaff(), other.id, { vehicleId: small.id })).toMatchObject({ ok: false, message: expect.stringContaining('holds at most 250 litres') as string });
      await db.update(schema.products).set({ volumeLitres: null }).where(eq(schema.products.id, o.b));
      expect(await c.deliveryRuns.assignVehicle(runStaff(), other.id, { vehicleId: small.id })).toMatchObject({ ok: true });
      expect((await runView(other.id)).totals).toMatchObject({ volumeLitres: null, stopsWithoutVolume: 1 });
    });

    it('keeps the volume limit in the register, refuses silly ones, records the change, and the database refuses them too', async () => {
      const v = await vehicle('Spacious', { maxVolumeLitres: 1200.5 });
      expect(v.maxVolumeLitres).toBe(1200.5);
      for (const bad of [0, -1, 'big', 2_000_000]) expect(await c.deliveryVehicles.create(runStaff(), { name: `Bad ${code()}`, maxVolumeLitres: bad })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryVehicles.update(runStaff(), v.id, { name: v.name, maxVolumeLitres: '', expectedVersion: v.version })).toMatchObject({ ok: true, data: { maxVolumeLitres: null } });
      await expect(db.update(schema.deliveryVehicles).set({ maxVolumeLitres: 0 }).where(eq(schema.deliveryVehicles.id, v.id))).rejects.toThrow();
      await expect(db.update(schema.products).set({ volumeLitres: '-3' }).where(eq(schema.products.id, (await order()).a))).rejects.toThrow();
    });

    it('refuses a stop beyond the most stops, counts goods without a weight as nothing, and puts no limit on a run with no vehicle from the list', async () => {
      const { o, first, second } = await twoParcels([null, null]);
      const one = await vehicle('Motorbike', { maxStops: 1, maxWeightKg: 5 });
      const run = await newRun(o.branchId, { vehicleId: one.id });
      // No weights are known, so only the stops can be over.
      expect(await c.deliveryRuns.addStop(runStaff(), run.id, first)).toMatchObject({ ok: true });
      expect(await c.deliveryRuns.addStop(runStaff(), run.id, second)).toMatchObject({ ok: false, message: expect.stringContaining('takes at most 1 stop on a run; this would be 2') as string });
      const free = await newRun(o.branchId, { vehicle: 'Typed in' });
      expect(await c.deliveryRuns.addStop(runStaff(), free.id, second)).toMatchObject({ ok: true });
    });

    it('lets only one of two people adding a stop at the same moment take the last place', async () => {
      const { o, first, second } = await twoParcels([null, null]);
      const one = await vehicle('Single seat', { maxStops: 1 });
      const run = await newRun(o.branchId, { vehicleId: one.id });
      const results = await Promise.all([c.deliveryRuns.addStop(runStaff(), run.id, first), c.deliveryRuns.addStop(runStaff(), run.id, second)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect((await runView(run.id)).totals.stops).toBe(1);
    });

    it('changes the vehicle of a planned run only to one that fits what is on it, can clear it, and refuses a run that has gone out', async () => {
      const { o, first, second } = await twoParcels();
      const roomy = await vehicle('Pickup', { maxWeightKg: 100 });
      const run = await newRun(o.branchId, { vehicleId: roomy.id });
      for (const d of [first, second]) expect(await c.deliveryRuns.addStop(runStaff(), run.id, d)).toMatchObject({ ok: true });
      // 16 kg on the run: a 12 kg vehicle is too small.
      const small = await vehicle('Tuk-tuk', { maxWeightKg: 12 });
      const tooSmall = await c.deliveryRuns.assignVehicle(runStaff(), run.id, { vehicleId: small.id });
      expect(tooSmall).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('choose a bigger vehicle') as string });
      expect(await runView(run.id)).toMatchObject({ vehicleId: roomy.id });
      const fits = await vehicle('Truck', { maxWeightKg: 16 });
      expect(await c.deliveryRuns.assignVehicle(runStaff(), run.id, { vehicleId: fits.id })).toMatchObject({ ok: true, data: { vehicleId: fits.id, vehicle: fits.name } });
      expect(await c.deliveryRuns.assignVehicle(runStaff(), run.id, { vehicleId: '', vehicle: 'Hired' })).toMatchObject({ ok: true, data: { vehicleId: null, vehicle: 'Hired', limits: null } });
      const started = await c.deliveryRuns.start(runStaff(), run.id);
      expect(started.ok).toBe(true);
      expect(await c.deliveryRuns.assignVehicle(runStaff(), run.id, { vehicleId: roomy.id })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });
  });
});
