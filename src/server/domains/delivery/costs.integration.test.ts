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
  const costsOf = async (where: { riderId: string }) => await db.select().from(schema.deliveryCosts).where(eq(schema.deliveryCosts.riderId, where.riderId));
  const deliver = (at: Awaited<ReturnType<typeof onTheRoad>>) => c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama' });

  describe('what riders are paid', () => {
    it('is two amounts, validated, versioned and logged', async () => {
      const now = await c.deliveryCosts.pay(companyId);
      expect(await c.deliveryCosts.setPay(dispatcher(), { perDelivery: -1, perDay: 0 })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCosts.setPay(dispatcher(), { perDelivery: 50, perDay: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCosts.setPay(dispatcher(), { perDelivery: 50, perDay: 200, expectedVersion: now.version + 9 })).toMatchObject({ ok: false, reason: 'conflict' });
      const ok = await c.deliveryCosts.setPay(dispatcher(), { perDelivery: 50, perDay: 200, expectedVersion: now.version });
      expect(ok).toMatchObject({ ok: true, data: { perDelivery: '50.00', perDay: '200.00' } });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, companyId));
      expect(log.map((l) => l.action)).toContain('delivery_pay.rules_set');
    });
  });

  describe('rider pay earned', () => {
    it('is counted for a delivery the rider makes, once, in the same transaction; a failed stop earns nothing', async () => {
      await setPay(50, 200);
      const rider = await staffRider();
      const a = await onTheRoad(rider);
      const b = await onTheRoad(rider);
      expect(await c.doorWork.fail(b.self, { runId: b.runId, deliveryId: b.deliveryId, clientKey: key(), reasonCode: 'refused' })).toMatchObject({ ok: true });
      const k = key();
      expect(await c.doorWork.deliver(a.self, { runId: a.runId, deliveryId: a.deliveryId, clientKey: k, receivedBy: 'Mama' })).toMatchObject({ ok: true });
      expect(await c.doorWork.deliver(a.self, { runId: a.runId, deliveryId: a.deliveryId, clientKey: k, receivedBy: 'Mama' })).toMatchObject({ ok: true, data: { replayed: true } });
      const costs = await costsOf({ riderId: rider.id });
      expect(costs.filter((x) => x.kind === 'rider_delivery')).toHaveLength(1);
      expect(costs[0]).toMatchObject({ kind: 'rider_delivery', amount: '50.00', deliveryId: a.deliveryId, runId: a.runId, currency: 'KES' });
      expect(costs.some((x) => x.deliveryId === b.deliveryId)).toBe(false);
    });

    it('is nothing when the rule is nothing', async () => {
      await setPay(0, 0);
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      await deliver(at);
      await c.doorWork.finish(at.self, at.runId);
      expect(await costsOf({ riderId: rider.id })).toHaveLength(0);
    });

    it('a day on a run earns day pay once for a rider and a day, however many runs, and only when something was delivered', async () => {
      await setPay(0, 200);
      const rider = await staffRider();
      const first = await onTheRoad(rider);
      await deliver(first);
      expect(await c.doorWork.finish(first.self, first.runId)).toMatchObject({ ok: true });
      const second = await onTheRoad(rider);
      await deliver(second);
      expect(await c.doorWork.finish(second.self, second.runId)).toMatchObject({ ok: true });
      const days = (await costsOf({ riderId: rider.id })).filter((x) => x.kind === 'rider_day');
      expect(days).toHaveLength(1);
      expect(days[0]).toMatchObject({ amount: '200.00', key: expect.stringContaining(`rider_day:${rider.id}:`) as string });
      // A run on which nothing was delivered earns no day pay.
      const idle = await staffRider();
      const none = await onTheRoad(idle);
      await c.doorWork.fail(none.self, { runId: none.runId, deliveryId: none.deliveryId, clientKey: key(), reasonCode: 'refused' });
      await c.doorWork.finish(none.self, none.runId);
      expect(await costsOf({ riderId: idle.id })).toHaveLength(0);
    });

    it('a stop the office delivered on the rider\'s behalf still earns the rider the delivery pay when the run closes, once', async () => {
      await setPay(30, 0);
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      expect((await c.deliveryDocuments.deliver(dispatcher(), at.deliveryId, { receivedBy: 'Mama' })).ok).toBe(true);
      expect(await costsOf({ riderId: rider.id })).toHaveLength(0);
      expect((await c.deliveryRuns.complete(dispatcher(), at.runId)).ok).toBe(true);
      const costs = await costsOf({ riderId: rider.id });
      expect(costs).toHaveLength(1);
      expect(costs[0]).toMatchObject({ kind: 'rider_delivery', amount: '30.00', deliveryId: at.deliveryId });
    });

    it('a rule changed later does not change pay already earned', async () => {
      await setPay(50, 0);
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      await deliver(at);
      await setPay(80, 0);
      expect((await costsOf({ riderId: rider.id }))[0]?.amount).toBe('50.00');
    });
  });

  describe('a courier\'s charge', () => {
    const courierDelivery = async () => {
      const ready = await readyDelivery();
      await db.update(schema.deliveries).set({ method: 'courier', courierName: 'Swift Couriers', status: 'out_for_delivery' }).where(eq(schema.deliveries.id, ready.deliveryId));
      return ready;
    };

    it('is typed in for a delivery sent with a courier, more than nothing, and a delivery can have more than one', async () => {
      const ready = await courierDelivery();
      expect(await c.deliveryCosts.recordCourier(dispatcher(), ready.deliveryId, { amount: 0 })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCosts.recordCourier(dispatcher(), randomUUID(), { amount: 300 })).toMatchObject({ ok: false, reason: 'not_found' });
      const one = await c.deliveryCosts.recordCourier(dispatcher(), ready.deliveryId, { amount: 300.5, note: 'Waybill SW123' });
      expect(one.ok).toBe(true);
      expect((await c.deliveryCosts.recordCourier(dispatcher(), ready.deliveryId, { amount: 50, note: 'Fuel surcharge' })).ok).toBe(true);
      const costs = await c.deliveryCosts.forDelivery(companyId, ready.deliveryId);
      expect(costs.map((x) => [x.kind, x.amount, x.courierName])).toEqual([['courier', '300.50', 'Swift Couriers'], ['courier', '50.00', 'Swift Couriers']]);
      const own = await readyDelivery();
      expect(await c.deliveryCosts.recordCourier(dispatcher(), own.deliveryId, { amount: 100 })).toMatchObject({ ok: false, reason: 'wrong_method' });
    });
  });

  describe('courier invoices matched to the charges', () => {
    /** A delivery with a courier of this name and `amount` charged for it; returns the cost's id. */
    const charged = async (courier: string, amount: number) => {
      const ready = await readyDelivery();
      await db.update(schema.deliveries).set({ method: 'courier', courierName: courier, status: 'out_for_delivery' }).where(eq(schema.deliveries.id, ready.deliveryId));
      const made = await c.deliveryCosts.recordCourier(dispatcher(), ready.deliveryId, { amount, note: `Waybill ${randomUUID().slice(0, 6)}` });
      if (!made.ok) throw new Error(made.message);
      return made.data.id;
    };
    const invoice = async (courier: string, total: number, no = `INV-${randomUUID().slice(0, 8)}`) => {
      const made = await c.courierInvoices.add(dispatcher(), { courierName: courier, invoiceNo: no, invoiceDate: '2026-01-15', total });
      if (!made.ok) throw new Error(made.message);
      return made.data.id;
    };
    const viewOf = async (id: string, courier: string) => (await c.courierInvoices.list(companyId, { courier })).rows.find((r) => r.id === id);

    it('records an invoice once for a courier and a number, with a day that is not in the future and money that makes sense', async () => {
      const courier = `Invoice Couriers ${randomUUID().slice(0, 6)}`;
      const id = await invoice(courier, 1000, 'SW-1');
      expect(await viewOf(id, courier)).toMatchObject({ courierName: courier, invoiceNo: 'SW-1', total: '1000.00', matchedCount: 0, matched: '0.00', difference: '-1000.00', state: 'open', voided: null });
      expect(await c.courierInvoices.add(dispatcher(), { courierName: courier.toUpperCase(), invoiceNo: 'sw-1', invoiceDate: '2026-01-15', total: 5 })).toMatchObject({ ok: false, reason: 'conflict' });
      for (const bad of [{ total: 0 }, { invoiceDate: '2099-01-01' }, { invoiceNo: '' }, { courierName: '' }]) {
        expect(await c.courierInvoices.add(dispatcher(), { courierName: courier, invoiceNo: 'SW-2', invoiceDate: '2026-01-15', total: 100, ...bad })).toMatchObject({ ok: false, reason: 'bad_input' });
      }
    });

    it('cannot be edited or deleted, only voided', async () => {
      const courier = `Guard Couriers ${randomUUID().slice(0, 6)}`;
      const id = await invoice(courier, 400);
      await expect(db.update(schema.courierInvoices).set({ total: '1.00' }).where(eq(schema.courierInvoices.id, id))).rejects.toThrow();
      await expect(db.update(schema.courierInvoices).set({ invoiceNo: 'CHANGED' }).where(eq(schema.courierInvoices.id, id))).rejects.toThrow();
      await expect(db.delete(schema.courierInvoices).where(eq(schema.courierInvoices.id, id))).rejects.toThrow();
      expect((await c.courierInvoices.voidInvoice(dispatcher(), id, { reason: 'Typed in by mistake' })).ok).toBe(true);
      // Once voided it is fixed for good, and a void needs its reason (both or none).
      await expect(db.update(schema.courierInvoices).set({ voidReason: 'Edited later' }).where(eq(schema.courierInvoices.id, id))).rejects.toThrow();
      const other = await invoice(courier, 10, 'G-2');
      await expect(db.update(schema.courierInvoices).set({ voidedAt: new Date() }).where(eq(schema.courierInvoices.id, other))).rejects.toThrow();
    });

    it('matches only this courier\'s charges, says short, agreed or over, never counts a charge twice, and lets one be taken off', async () => {
      const courier = `Match Couriers ${randomUUID().slice(0, 6)}`;
      const a = await charged(courier, 300);
      const b = await charged(courier, 200.5);
      const other = await charged(`Other ${randomUUID().slice(0, 6)}`, 100);
      const id = await invoice(courier, 600);
      // The candidates are this courier's, not on an invoice, newest first.
      expect((await c.courierInvoices.candidates(companyId, id)).rows.map((r) => r.costId).sort()).toEqual([a, b].sort());
      expect(await c.courierInvoices.match(dispatcher(), id, { costIds: [other] })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.courierInvoices.match(dispatcher(), id, { costIds: [randomUUID()] })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.courierInvoices.match(dispatcher(), id, { costIds: [] })).toMatchObject({ ok: false, reason: 'bad_input' });
      const first = await c.courierInvoices.match(dispatcher(), id, { costIds: [a] });
      expect(first).toMatchObject({ ok: true, data: { matchedCount: 1, matched: '300.00', difference: '-300.00', state: 'short' } });
      // All or none: a charge already on the invoice refuses the lot, and nothing of it is counted.
      expect(await c.courierInvoices.match(dispatcher(), id, { costIds: [a, b] })).toMatchObject({ ok: false, reason: 'conflict' });
      expect((await viewOf(id, courier))?.matchedCount).toBe(1);
      const second = await c.courierInvoices.match(dispatcher(), id, { costIds: [b] });
      expect(second).toMatchObject({ ok: true, data: { matched: '500.50', difference: '-99.50', state: 'short' } });
      expect((await c.courierInvoices.matchedCharges(companyId, id)).map((r) => r.costId).sort()).toEqual([a, b].sort());
      // A charge is on one invoice only: another invoice cannot take it.
      const id2 = await invoice(courier, 300);
      expect(await c.courierInvoices.match(dispatcher(), id2, { costIds: [a] })).toMatchObject({ ok: false, reason: 'conflict' });
      expect((await c.courierInvoices.candidates(companyId, id2)).rows).toHaveLength(0);
      // Taken off, it is free again; matching it again gives agreement and then, with another charge, over.
      expect(await c.courierInvoices.unmatch(dispatcher(), id, { costId: b })).toMatchObject({ ok: true, data: { matchedCount: 1, state: 'short' } });
      expect(await c.courierInvoices.unmatch(dispatcher(), id, { costId: b })).toMatchObject({ ok: false, reason: 'not_found' });
      const c2 = await charged(courier, 300);
      expect(await c.courierInvoices.match(dispatcher(), id, { costIds: [c2] })).toMatchObject({ ok: true, data: { matched: '600.00', difference: '0.00', state: 'agreed' } });
      expect(await c.courierInvoices.match(dispatcher(), id, { costIds: [b] })).toMatchObject({ ok: true, data: { state: 'over', difference: '200.50' } });
    });

    it('does not count a charge that was taken back, and a company cannot reach another company\'s invoice or charge', async () => {
      const courier = `Back Couriers ${randomUUID().slice(0, 6)}`;
      const a = await charged(courier, 120);
      const id = await invoice(courier, 120);
      expect((await c.deliveryCosts.reverse(dispatcher(), a, { reason: 'Charged to the wrong courier' })).ok).toBe(true);
      expect((await c.courierInvoices.candidates(companyId, id)).rows).toHaveLength(0);
      expect(await c.courierInvoices.match(dispatcher(), id, { costIds: [a] })).toMatchObject({ ok: false, reason: 'conflict' });
      const live = await charged(courier, 80);
      const stranger = { companyId: randomUUID(), userId: 'x' };
      expect(await c.courierInvoices.match(stranger, id, { costIds: [live] })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.courierInvoices.voidInvoice(stranger, id, { reason: 'Not yours to void' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect((await c.courierInvoices.list(randomUUID(), { courier })).rows).toEqual([]);
      expect((await c.courierInvoices.candidates(randomUUID(), id)).rows).toEqual([]);
    });

    it('voids an invoice with a reason, frees its charges for another invoice and frees its number', async () => {
      const courier = `Void Couriers ${randomUUID().slice(0, 6)}`;
      const a = await charged(courier, 250);
      const id = await invoice(courier, 250, 'V-1');
      expect((await c.courierInvoices.match(dispatcher(), id, { costIds: [a] })).ok).toBe(true);
      expect((await c.courierInvoices.unbilled(companyId)).find((u) => u.courier === courier)).toBeUndefined();
      expect(await c.courierInvoices.voidInvoice(dispatcher(), id, { reason: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
      const voided = await c.courierInvoices.voidInvoice(dispatcher(), id, { reason: 'Typed against the wrong courier' });
      expect(voided).toMatchObject({ ok: true, data: { voided: { reason: 'Typed against the wrong courier' }, matchedCount: 0 } });
      expect(await c.courierInvoices.voidInvoice(dispatcher(), id, { reason: 'Again please' })).toMatchObject({ ok: false, reason: 'conflict' });
      expect(await c.courierInvoices.match(dispatcher(), id, { costIds: [a] })).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(await c.courierInvoices.unmatch(dispatcher(), id, { costId: a })).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect((await c.courierInvoices.unbilled(companyId)).find((u) => u.courier === courier)).toMatchObject({ count: 1, total: '250.00' });
      // The number is free again, and the freed charge goes on the new one.
      const again = await invoice(courier, 250, 'V-1');
      expect(await c.courierInvoices.match(dispatcher(), again, { costIds: [a] })).toMatchObject({ ok: true, data: { state: 'agreed' } });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, id));
      expect(log.map((l) => l.action).sort()).toEqual(['courier_invoice.added', 'courier_invoice.matched', 'courier_invoice.voided']);
    });

    it('lists newest first, one page at a time', async () => {
      const courier = `Page Couriers ${randomUUID().slice(0, 6)}`;
      const ids: string[] = [];
      for (let i = 0; i < 22; i += 1) ids.push(await invoice(courier, 10 + i));
      const first = await c.courierInvoices.list(companyId, { courier });
      expect(first.rows).toHaveLength(20);
      expect(first.rows[0]?.id).toBe(ids[21]);
      expect(first.nextCursor).not.toBeNull();
      const next = await c.courierInvoices.list(companyId, { courier, cursor: first.nextCursor });
      expect(next.rows.map((r) => r.id)).toEqual([ids[1], ids[0]]);
      expect(next.nextCursor).toBeNull();
    });
  });

  describe('taking a cost back', () => {
    it('is a reversing entry with a reason, once, and the first stays on record', async () => {
      await setPay(50, 0);
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      await deliver(at);
      const [cost] = await costsOf({ riderId: rider.id });
      const id = cost?.id ?? '';
      expect(await c.deliveryCosts.reverse(dispatcher(), id, { reason: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCosts.reverse(dispatcher(), randomUUID(), { reason: 'Paid twice by mistake' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.deliveryCosts.reverse(dispatcher(), id, { reason: 'The delivery was not made by this rider' })).toMatchObject({ ok: true });
      expect(await c.deliveryCosts.reverse(dispatcher(), id, { reason: 'Again please' })).toMatchObject({ ok: false, reason: 'conflict' });
      const all = await costsOf({ riderId: rider.id });
      expect(all).toHaveLength(2);
      expect(all.reduce((n, x) => n + Math.round(Number(x.amount) * 100), 0)).toBe(0);
      const reversal = all.find((x) => x.reversesId !== null);
      expect(reversal).toMatchObject({ amount: '-50.00', note: 'The delivery was not made by this rider', reversesId: id });
      expect(await c.deliveryCosts.reverse(dispatcher(), reversal?.id ?? '', { reason: 'Reverse the reversal' })).toMatchObject({ ok: false, reason: 'not_allowed' });
      const view = await c.deliveryCosts.forDelivery(companyId, at.deliveryId);
      expect(view.find((x) => x.id === id)?.reversed).toBe(true);
    });

    it('cannot be edited or removed, even straight in the database, and a negative cost must name what it takes back', async () => {
      await setPay(50, 0);
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      await deliver(at);
      const [cost] = await costsOf({ riderId: rider.id });
      await expect(db.update(schema.deliveryCosts).set({ amount: '1.00' }).where(eq(schema.deliveryCosts.id, cost?.id ?? ''))).rejects.toThrow();
      await expect(db.delete(schema.deliveryCosts).where(eq(schema.deliveryCosts.id, cost?.id ?? ''))).rejects.toThrow();
      await expect(db.insert(schema.deliveryCosts).values({ companyId, kind: 'other', amount: '-5.00', currency: 'KES', key: `x:${randomUUID()}`, actorId: 'x' })).rejects.toThrow();
      await expect(db.insert(schema.deliveryCosts).values({ companyId, kind: 'rider_day', amount: '5.00', currency: 'KES', key: `y:${randomUUID()}`, actorId: 'x' })).rejects.toThrow();
    });
  });

  describe('fuel and vehicle costs', () => {
    it('are saved with what they were for, tied to a run when the office says so, once for a form, and appear in the report', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      const before = await c.deliveryReports.summary(companyId, {});
      const clientKey = randomUUID();
      const made = await c.deliveryCosts.recordRunning(dispatcher(), { kind: 'fuel', amount: 1500.5, note: 'KDA 123X, Thika road', runId: at.runId, clientKey });
      expect(made).toMatchObject({ ok: true, data: { replayed: false } });
      // The same form sent again (a double click, a retry) saves nothing more.
      expect(await c.deliveryCosts.recordRunning(dispatcher(), { kind: 'fuel', amount: 1500.5, note: 'KDA 123X, Thika road', runId: at.runId, clientKey })).toMatchObject({ ok: true, data: { replayed: true } });
      expect((await c.deliveryCosts.recordRunning(dispatcher(), { kind: 'vehicle', amount: 800, note: 'Puncture', clientKey: randomUUID() })).ok).toBe(true);
      const rows = await costsOf({ riderId: rider.id });
      const fuel = rows.find((r) => r.kind === 'fuel');
      expect(fuel).toMatchObject({ amount: '1500.50', note: 'KDA 123X, Thika road' });
      const shown = (await c.deliveryCosts.list(companyId, { riderId: rider.id })).rows.find((r) => r.id === fuel?.id);
      expect(shown?.runNumber).not.toBeNull();
      expect(shown?.kindWords).toBe('Fuel');
      const after = await c.deliveryReports.summary(companyId, {});
      if (!before.ok || !after.ok) throw new Error('report');
      expect(Number(after.data.fuelCosts) - Number(before.data.fuelCosts)).toBe(1500.5);
      expect(Number(after.data.vehicleCosts) - Number(before.data.vehicleCosts)).toBe(800);
      expect(Number(after.data.cost) - Number(before.data.cost)).toBe(2300.5);
      // They are not rider pay: nothing is owed to the rider for them and nothing is queued for the books.
      const queued = await db.select({ id: schema.deliveryCostPostings.costId }).from(schema.deliveryCostPostings).where(eq(schema.deliveryCostPostings.costId, fuel?.id ?? ''));
      expect(queued).toHaveLength(0);
      // A mistake is taken back with a reason, like any cost.
      expect((await c.deliveryCosts.reverse(dispatcher(), fuel?.id ?? '', { reason: 'Typed twice by mistake' })).ok).toBe(true);
    });

    it('are refused without a kind, money, words or a form key, and for a run that is not the company\'s', async () => {
      const ok = { kind: 'fuel', amount: 100, note: 'Diesel', clientKey: randomUUID() };
      expect(await c.deliveryCosts.recordRunning(dispatcher(), { ...ok, kind: 'courier' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCosts.recordRunning(dispatcher(), { ...ok, amount: 0 })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCosts.recordRunning(dispatcher(), { ...ok, note: '' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCosts.recordRunning(dispatcher(), { ...ok, clientKey: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCosts.recordRunning(dispatcher(), { ...ok, runId: randomUUID() })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCosts.recordRunning({ ...dispatcher(), companyId: randomUUID() }, { ...ok, runId: randomUUID() })).toMatchObject({ ok: false });
    });
  });

  describe('listing', () => {
    it('is newest first, by kind and rider, one page at a time', async () => {
      await setPay(50, 100);
      const rider = await staffRider();
      for (let i = 0; i < 2; i += 1) {
        const at = await onTheRoad(rider);
        await deliver(at);
        await c.doorWork.finish(at.self, at.runId);
      }
      const all = await c.deliveryCosts.list(companyId, { riderId: rider.id });
      expect(all.rows.length).toBeGreaterThanOrEqual(3);
      expect(all.rows.map((r) => r.createdAt)).toEqual([...all.rows.map((r) => r.createdAt)].sort().reverse());
      const onlyDays = await c.deliveryCosts.list(companyId, { riderId: rider.id, kind: 'rider_day' });
      expect(onlyDays.rows.every((r) => r.kind === 'rider_day')).toBe(true);
      expect(onlyDays.rows[0]).toMatchObject({ riderName: expect.any(String) as string, kindWords: 'Rider pay for a day on a run' });
      const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
      expect((await c.deliveryCosts.list(companyId, { riderId: rider.id, from: today, to: today })).rows.length).toBe(all.rows.length);
      expect((await c.deliveryCosts.list(companyId, { riderId: rider.id, from: '2001-01-01', to: '2001-01-02' })).rows).toHaveLength(0);
    });
  });
});
