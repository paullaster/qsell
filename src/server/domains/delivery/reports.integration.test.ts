import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import type { OrderStages as OrderStagesType } from '@/server/domains/orders/stages';
import { holdLedgerSwitch, settleFinanceBacklog } from '@/server/domains/stock/test-support';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }));

/**
 * Riders, against a real database: which kinds a company uses (its staff, riders with an account of their own, or both), adding
 * them, pausing and ending them, giving runs to them, and what the rider app shows each of them (their own runs, and no one else's).
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const PIN = { latitude: -1.2921, longitude: 36.8219 };

describe.skipIf(!has(url))('cash at the door (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let OrderStages: typeof OrderStagesType;
  let companyId: string;
  let releaseLedgerSwitch: (() => Promise<void>) | undefined;
  let itemTypeId: string;
  let spy: { mockRestore: () => void } | undefined;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  let n = 0;
  const code = () => `DP${tag}${String((n += 1)).padStart(3, '0')}`;
  const madeBranches: string[] = [];
  const madeLocations: string[] = [];
  const madeUsers: string[] = [];
  const dispatcher = () => ({ companyId, userId: 'dispatcher-1' });

  const kinds = async (allowStaff: boolean, allowSeparate: boolean) => {
    const now = await c.deliveryRiders.settings(companyId);
    const r = await c.deliveryRiders.setKinds(dispatcher(), { allowStaff, allowSeparate, expectedVersion: now.version });
    if (!r.ok) throw new Error(r.message);
  };

  /** A person with an account: `staff` (a role that may sign in to the back office) or a plain customer. */
  const person = async (role: 'super_admin' | 'customer', over: Partial<{ isActive: boolean; status: string }> = {}) => {
    const id = randomUUID();
    await db.insert(schema.users).values({ id, email: `rd-${id}@riders.test`, passwordHash: 'x', name: `Person ${id.slice(0, 4)}`, role, phone: '0711000111', ...over });
    madeUsers.push(id);
    return id;
  };
  const proofRule = async (proof: 'none' | 'code' | 'photo' | 'code_or_photo') => {
    const now = await c.deliveryRiders.settings(companyId);
    const r = await c.deliveryRiders.setProof(dispatcher(), { proof, expectedVersion: now.version });
    if (!r.ok) throw new Error(r.message);
  };
  const key = () => randomUUID().replace(/-/g, '');
  const selfOf = async (userId: string) => {
    const s = await c.deliveryRiders.forUser(userId);
    if (s === null) throw new Error('not a rider');
    return s;
  };
  /** A ready delivery put on a run of this rider that has gone out: the rider is at the first door. */
  const onTheRoad = async (rider: { id: string; userId: string }) => {
    const ready = await readyDelivery();
    const run = await runFor(rider.id, ready.branchId);
    const added = await c.deliveryRuns.addStop(dispatcher(), run.id, ready.deliveryId);
    if (!added.ok) throw new Error(added.message);
    const started = await c.deliveryRuns.start(dispatcher(), run.id);
    if (!started.ok) throw new Error(started.message);
    return { runId: run.id, deliveryId: ready.deliveryId, self: await selfOf(rider.userId) };
  };
  const staffRider = async (over: { phone?: string } = {}) => {
    const userId = await person('super_admin');
    const r = await c.deliveryRiders.addStaff(dispatcher(), { userId, ...over });
    if (!r.ok) throw new Error(r.message);
    return { id: r.data.id, userId };
  };
  const branch = async () => {
    const [b] = await db.insert(schema.branches).values({ companyId, code: code(), name: `Branch ${code()}`, latitude: PIN.latitude, longitude: PIN.longitude }).returning();
    const id = b?.id ?? '';
    madeBranches.push(id);
    return id;
  };
  /** The business day, in Nairobi: between midnight and 3am the UTC date is still yesterday. */
  const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
  const runFor = async (riderId: string, branchId: string) => {
    const r = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId });
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  /** A placed, paid order delivered by the shop's own riders from a branch that holds the goods, with a delivery ready to go on a run. */
  const readyDelivery = async (opts: { atDoor?: boolean; lines?: 'some' } = {}) => {
    const branchId = await branch();
    await db.insert(schema.deliveryMethods).values({ companyId, branchId, method: 'own_fleet' });
    const productId = `prod_rd_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `RD-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `RDS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Carried ${productId.slice(-6)}`, slug: `rd-${randomUUID()}`, itemTypeId, price: '1000', costPrice: '10', taxRate: '0', isTaxInclusive: false, stockQuantity: 0 });
    const loc = await c.stockLocations.create(companyId, { code: code(), name: 'Shelf', kind: 'store', branchId, fulfilsDelivery: true });
    madeLocations.push(loc.id);
    await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId: loc.id, type: 'receipt', quantity: 50, unitCost: 10, actor: { type: 'job' } }));
    const policies = await import('./policy-actions');
    const made = await policies.createChargePolicyDraftAction(code(), { name: 'Flat', method: 'flat', currency: 'KES', scopes: { branch: { op: 'in', values: [branchId] } }, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 300 }], taxRate: 0 });
    if (!made.ok) throw new Error(made.error);
    const live = await policies.activateChargePolicyAction(made.data.id, 'Set up for the test');
    if (!live.ok) throw new Error(live.error);
    const r = await createOrder({
      orderNumber: `RD-${randomUUID()}`, customerName: 'Wanjiru Buyer', customerEmail: `rd-${randomUUID()}@deliver.test`, customerPhone: '0700123456',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: 3 }], currency: 'KES', paymentMethod: 'mpesa_daraja', delivery: { method: 'own_fleet', pin: PIN },
    });
    if (!r.success || r.order === undefined) throw new Error(r.error);
    if (opts.atDoor !== true) await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    const productIdFor = productId;
    const doc = await c.deliveryDocuments.create(dispatcher(), r.order.id, { lines: opts.lines === 'some' ? [{ productId: productIdFor, quantity: 1 }] : null });
    if (!doc.ok) throw new Error(doc.message);
    const d = c.deliveryDocuments;
    if (opts.atDoor === true) {
      const marked = await c.doorPayments.mark(dispatcher(), doc.data.id, { reason: 'Customer will pay when it arrives' });
      if (!marked.ok) throw new Error(marked.message);
    }
    for (const step of [() => d.release(dispatcher(), doc.data.id), () => d.startPicking(dispatcher(), doc.data.id)]) {
      const s = await step();
      if (!s.ok) throw new Error(s.message);
    }
    const view = await d.get(companyId, doc.data.id);
    const lines = (view?.lines ?? []).map((l) => ({ productId: l.productId, quantity: l.quantity }));
    for (const step of [() => d.recordPicked(dispatcher(), doc.data.id, { picked: lines }), () => d.markPacked(dispatcher(), doc.data.id), () => d.markReady(dispatcher(), doc.data.id)]) {
      const s = await step();
      if (!s.ok) throw new Error(s.message);
    }
    return { deliveryId: doc.data.id, branchId, orderId: r.order.id, total: r.order.totalAmount, productName: `Carried ${productId.slice(-6)}` };
  };

  beforeAll(async () => {
    releaseLedgerSwitch = await holdLedgerSwitch(url);
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ OrderStages } = await import('@/server/domains/orders/stages'));
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Riders Test Co');
    itemTypeId = `it_rd_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await c.stockLocations.ensureDefault(companyId);
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  }, 900_000);
  afterAll(async () => {
    await releaseLedgerSwitch?.();
  }, 60_000);
  afterAll(async () => {
    spy?.mockRestore();
    await c.stockSettings.setIssueMoment(companyId, 'payment');
    await c.stockSettings.setLedgerMode(companyId, false);
    const rest = await db.select({ id: schema.chargePolicies.id }).from(schema.chargePolicies).where(like(schema.chargePolicies.code, `DP${tag}%`));
    if (rest.length > 0) {
      await db.delete(schema.chargePolicyRates).where(inArray(schema.chargePolicyRates.policyId, rest.map((r) => r.id)));
      await db.delete(schema.chargePolicies).where(inArray(schema.chargePolicies.id, rest.map((r) => r.id)));
    }
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(async () => {
    requirePermission.mockReset().mockResolvedValue('dispatcher-1');
    await kinds(true, true);
    await proofRule('none');
  });
  afterEach(async () => {
    // Riders made by one test must not count against the next test's choice of kinds.
    if (madeUsers.length > 0) await db.update(schema.deliveryRiders).set({ status: 'ended', statusReason: 'test over' }).where(inArray(schema.deliveryRiders.userId, madeUsers));
    if (madeBranches.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, madeBranches));
    if (madeLocations.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations));
  });

  const setPay = async (perDelivery: number, perDay: number) => {
    const now = await c.deliveryCosts.pay(companyId);
    const r = await c.deliveryCosts.setPay(dispatcher(), { perDelivery, perDay, expectedVersion: now.version });
    if (!r.ok) throw new Error(r.message);
  };
  const report = async (from = today(), to = today()) => {
    const r = await c.deliveryReports.summary(companyId, { from, to });
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  it('counts what was delivered, the delivery charge once an order, what it cost, and the margin', async () => {
    await setPay(40, 100);
    const before = await report();
    const rider = await staffRider();
    const a = await onTheRoad(rider);
    const b = await onTheRoad(rider);
    await c.doorWork.deliver(a.self, { runId: a.runId, deliveryId: a.deliveryId, clientKey: key(), receivedBy: 'A' });
    await c.doorWork.deliver(b.self, { runId: b.runId, deliveryId: b.deliveryId, clientKey: key(), receivedBy: 'B' });
    await c.doorWork.finish(a.self, a.runId);
    const after = await report();
    expect(after.delivered - before.delivered).toBe(2);
    // The harness delivers with a flat charge of 300 each (two orders): the charge counts once for each order.
    expect(Number(after.charge) - Number(before.charge)).toBe(600);
    expect(Number(after.riderPay) - Number(before.riderPay)).toBe(180);
    expect(Number(after.cost) - Number(before.cost)).toBe(180);
    expect(Number(after.margin) - Number(before.margin)).toBe(420);
    expect(after.marginPercent).not.toBeNull();
    const mine = after.byRider.find((r) => r.riderId === rider.id);
    expect(mine).toMatchObject({ delivered: 2, failed: 0, pay: '180.00' });
  });

  it('an order split in two counts its charge once, on the first delivery that was delivered', async () => {
    const before = await report();
    const ready = await readyDelivery({ lines: 'some' });
    const view = await c.deliveryDocuments.get(companyId, ready.deliveryId);
    expect(view?.status).toBe('ready');
    // The rest of the order goes on a second delivery.
    const second = await c.deliveryDocuments.create(dispatcher(), ready.orderId, { lines: null });
    expect(second.ok).toBe(true);
    for (const id of [ready.deliveryId, second.ok ? second.data.id : '']) {
      const lines = (await c.deliveryDocuments.get(companyId, id))?.lines ?? [];
      const steps = [() => c.deliveryDocuments.release(dispatcher(), id), () => c.deliveryDocuments.startPicking(dispatcher(), id)];
      if ((await c.deliveryDocuments.get(companyId, id))?.status === 'draft') for (const s of steps) await s();
      if ((await c.deliveryDocuments.get(companyId, id))?.status === 'picking') {
        await c.deliveryDocuments.recordPicked(dispatcher(), id, { picked: lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) });
        await c.deliveryDocuments.markPacked(dispatcher(), id);
        await c.deliveryDocuments.markReady(dispatcher(), id);
      }
      await c.deliveryDocuments.dispatch(dispatcher(), id, {});
      expect((await c.deliveryDocuments.deliver(dispatcher(), id, { receivedBy: 'Mama' })).ok).toBe(true);
    }
    const after = await report();
    expect(after.delivered - before.delivered).toBe(2);
    expect(Number(after.charge) - Number(before.charge)).toBe(300);
  });

  it('adds a courier\'s charge by courier, and failed attempts by reason', async () => {
    const before = await report();
    const rider = await staffRider();
    const at = await onTheRoad(rider);
    await c.doorWork.fail(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), reasonCode: 'customer_absent' });
    const ready = await readyDelivery();
    await db.update(schema.deliveries).set({ method: 'courier', courierName: 'Swift Couriers', status: 'out_for_delivery' }).where(eq(schema.deliveries.id, ready.deliveryId));
    expect((await c.deliveryCosts.recordCourier(dispatcher(), ready.deliveryId, { amount: 350 })).ok).toBe(true);
    const after = await report();
    expect(after.failedAttempts - before.failedAttempts).toBe(1);
    expect(after.failures.find((f) => f.code === 'customer_absent')).toMatchObject({ words: 'Nobody was there' });
    expect(Number(after.courierCharges) - Number(before.courierCharges)).toBe(350);
    const swift = after.byCourier.find((x) => x.courier === 'Swift Couriers');
    const was = before.byCourier.find((x) => x.courier === 'Swift Couriers');
    expect(Number(swift?.charged) - Number(was?.charged ?? 0)).toBe(350);
    expect(after.byRider.find((r) => r.riderId === rider.id)).toMatchObject({ failed: 1, delivered: 0 });
    expect(after.byZone.length).toBeGreaterThanOrEqual(0);
  });

  it('a cost taken back counts against what it was, and a period outside the days is empty', async () => {
    await setPay(25, 0);
    const before = await report();
    const rider = await staffRider();
    const at = await onTheRoad(rider);
    await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'A' });
    const [cost] = await db.select().from(schema.deliveryCosts).where(eq(schema.deliveryCosts.riderId, rider.id));
    await c.deliveryCosts.reverse(dispatcher(), cost?.id ?? '', { reason: 'Not this rider\'s delivery' });
    const after = await report();
    expect(Number(after.riderPay) - Number(before.riderPay)).toBe(0);
    const old = await report('2001-01-01', '2001-01-31');
    expect(old).toMatchObject({ delivered: 0, failedAttempts: 0, charge: '0.00', cost: '0.00', margin: '0.00', marginPercent: null, byRider: [], byCourier: [], failures: [] });
  });

  it('refuses days that make no sense', async () => {
    expect(await c.deliveryReports.summary(companyId, { from: '2026-11-05', to: '2026-11-01' })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.deliveryReports.summary(companyId, { from: '2020-01-01', to: '2026-11-01' })).toMatchObject({ ok: false, reason: 'bad_input' });
  });
  describe('performance: on time, first try, riders, couriers and delivery times', () => {
    const performance = async (from = today(), to = today()) => {
      const r = await c.deliveryPerformance.summary(companyId, { from, to });
      if (!r.ok) throw new Error(r.message);
      return r.data;
    };
    /** Gives a delivery a delivery time on a slot of its branch, today, with a window that ends this many minutes from now. */
    const promise = async (deliveryId: string, slotId: string, endsInMinutes: number) => {
      const now = new Date();
      await db.update(schema.deliveries).set({ slotId, slotDay: today(), windowStart: new Date(now.getTime() + (endsInMinutes - 120) * 60_000), windowEnd: new Date(now.getTime() + endsInMinutes * 60_000), slotBookedAt: now, slotBookedBy: 'dispatcher-1' }).where(eq(schema.deliveries.id, deliveryId));
    };
    const slotOf = async (deliveryId: string, capacity = 2) => {
      const branchId = (await c.deliveryDocuments.get(companyId, deliveryId))?.branch.id ?? '';
      const made = await c.deliverySlots.create(dispatcher(), { branchId, name: `Perf ${code()}`, weekdays: [1, 2, 3, 4, 5, 6, 7], startsAt: '09:00', endsAt: '12:00', capacity, cutoffMinutes: 0 });
      if (!made.ok) throw new Error(made.message);
      return made.data.id;
    };

    it('counts what was delivered in time, what was late and by how much, the first try, and who handed it over', async () => {
      const rider = await staffRider();
      const early = await onTheRoad(rider);
      const late = await onTheRoad(rider);
      const none = await onTheRoad(rider);
      const slot = await slotOf(early.deliveryId, 5);
      await promise(early.deliveryId, slot, 60);
      await promise(late.deliveryId, slot, -30);
      for (const at of [early, late, none]) expect((await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama' })).ok).toBe(true);
      const mine = (await performance()).byRider.find((r) => r.riderId === rider.id);
      // Two were promised a window and one of them was in time; the third was promised nothing, so it is not in the rate.
      expect(mine).toMatchObject({ delivered: 3, promised: 2, onTime: 1, onTimePercent: 50, firstTryPercent: 100 });
      expect(mine?.averageTransitMinutes).not.toBeNull();
      const total = (await performance()).total;
      expect(total.averageLateMinutes).not.toBeNull();
      expect(total.onTimePercent).not.toBeNull();
    });

    it('a delivery that was sent again is not counted as delivered at the first try', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      expect((await c.doorWork.fail(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), reasonCode: 'customer_absent' })).ok).toBe(true);
      expect((await c.doorWork.finish(at.self, at.runId)).ok).toBe(true);
      expect((await c.deliveryDocuments.reattempt(dispatcher(), at.deliveryId, { note: 'Try again' })).ok).toBe(true);
      const branchId = (await c.deliveryDocuments.get(companyId, at.deliveryId))?.branch.id ?? '';
      const run = await runFor(rider.id, branchId);
      expect((await c.deliveryRuns.addStop(dispatcher(), run.id, at.deliveryId)).ok).toBe(true);
      expect((await c.deliveryRuns.start(dispatcher(), run.id)).ok).toBe(true);
      expect((await c.doorWork.deliver(at.self, { runId: run.id, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama' })).ok).toBe(true);
      const mine = (await performance()).byRider.find((r) => r.riderId === rider.id);
      expect(mine).toMatchObject({ delivered: 1, firstTryPercent: 0, promised: 0, onTimePercent: null });
    });

    it('shows a courier by what was sent, what arrived and in time, what did not get through and what could not be booked', async () => {
      const name = `Perf Couriers ${code()}`;
      const a = await readyDelivery();
      const b = await readyDelivery();
      const slot = await slotOf(a.deliveryId, 5);
      for (const r of [a, b]) {
        await db.update(schema.deliveries).set({ method: 'courier' }).where(eq(schema.deliveries.id, r.deliveryId));
        expect((await c.deliveryDocuments.dispatch(dispatcher(), r.deliveryId, { courierName: name, trackingNumber: `T${code()}` })).ok).toBe(true);
      }
      await promise(a.deliveryId, slot, -10);
      expect((await c.deliveryDocuments.deliver(dispatcher(), a.deliveryId, { receivedBy: 'Mama' })).ok).toBe(true);
      await db.update(schema.deliveryShipments).set({ syncState: 'book_failed', syncError: 'The courier could not be reached.' }).where(eq(schema.deliveryShipments.deliveryId, b.deliveryId));
      const row = (await performance()).byCourier.find((x) => x.courier === name);
      expect(row).toMatchObject({ sent: 2, delivered: 1, promised: 1, onTimePercent: 0, problems: 1 });
      expect(row?.averageTransitMinutes).not.toBeNull();
    });

    it('measures how full a delivery time ran, the days it was full, closed days, and times chosen that were not kept', async () => {
      await db.delete(schema.deliveryClosedDays).where(eq(schema.deliveryClosedDays.companyId, companyId));
      const rider = await staffRider();
      const one = await onTheRoad(rider);
      const two = await onTheRoad(rider);
      const slot = await slotOf(one.deliveryId, 2);
      await promise(one.deliveryId, slot, 60);
      await promise(two.deliveryId, slot, 90);
      const before = await performance();
      const row = before.bySlot.find((s) => s.slotId === slot);
      // One day in the period, room for two, both booked: used in full.
      expect(row).toMatchObject({ openDays: 1, offered: 2, booked: 2, fullDays: 1, fillPercent: 100, capacity: 2 });
      // A closed day takes the slot's room away for that day.
      const closed = await c.deliverySlots.close(dispatcher(), { day: today(), reason: 'Public holiday' });
      expect(closed.ok).toBe(true);
      const after = (await performance()).bySlot.find((s) => s.slotId === slot);
      expect(after).toMatchObject({ openDays: 0, offered: 0, booked: 2, fillPercent: null });
      // A time a customer chose at checkout that had gone by the time the delivery was made is counted as not kept.
      const asked = await readyDelivery();
      await db.insert(schema.orderSlotRequests).values({ orderId: asked.orderId, companyId, slotId: slot, day: today(), outcome: 'unavailable', outcomeNote: 'It filled up', settledAt: new Date() });
      const wanted = await performance();
      expect(wanted.notKept - before.notKept).toBe(1);
      expect(wanted.chosen - before.chosen).toBe(1);
      // A cancelled delivery no longer holds a place.
      await db.update(schema.deliveries).set({ status: 'cancelled', closedAt: new Date() }).where(eq(schema.deliveries.id, two.deliveryId));
      expect((await performance()).bySlot.find((s) => s.slotId === slot)?.booked).toBe(1);
      await db.delete(schema.deliveryClosedDays).where(eq(schema.deliveryClosedDays.companyId, companyId));
    });

    it('is empty and honest for days with nothing, and refuses days that make no sense', async () => {
      const old = await performance('2001-01-01', '2001-01-31');
      expect(old.total).toMatchObject({ delivered: 0, onTimePercent: null, firstTryPercent: null, averageTransitMinutes: null, averageLateMinutes: null, averageTotalMinutes: null });
      expect(old.byRider).toEqual([]);
      expect(old.byCourier).toEqual([]);
      expect(old.chosen).toBe(0);
      expect(await c.deliveryPerformance.summary(companyId, { from: '2026-11-05', to: '2026-11-01' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryPerformance.summary(companyId, { from: '2020-01-01', to: '2026-11-01' })).toMatchObject({ ok: false, reason: 'bad_input' });
    });
  });
});
