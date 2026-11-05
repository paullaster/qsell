import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { has } from '@/lib/values';
import { DoorMpesa } from './door-mpesa';
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
  let cashMethod = '';
  let otherMethod = '';
  // For hand-ins: a method of its own whose account stands for cash with riders, the till cash goes into, and where differences are written.
  let ridersMethod = '';
  let tillBankId = '';
  let varianceGl = '';
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
  const onTheRoad = async (rider: { id: string; userId: string }, opts: { atDoor?: boolean } = {}) => {
    const ready = await readyDelivery(opts);
    const run = await runFor(rider.id, ready.branchId);
    const added = await c.deliveryRuns.addStop(dispatcher(), run.id, ready.deliveryId);
    if (!added.ok) throw new Error(added.message);
    const started = await c.deliveryRuns.start(dispatcher(), run.id);
    if (!started.ok) throw new Error(started.message);
    return { runId: run.id, deliveryId: ready.deliveryId, orderId: ready.orderId, total: ready.total, self: await selfOf(rider.userId) };
  };
  const attemptsOf = async (deliveryId: string) => await db.select().from(schema.deliveryAttempts).where(eq(schema.deliveryAttempts.deliveryId, deliveryId));
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
  const today = () => new Date().toISOString().slice(0, 10);
  const runFor = async (riderId: string, branchId: string) => {
    const r = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId });
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  /** A placed, paid order delivered by the shop's own riders from a branch that holds the goods, with a delivery ready to go on a run. */
  const readyDelivery = async (opts: { atDoor?: boolean; lines?: 'some'; draftOnly?: boolean } = {}) => {
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
    if (opts.atDoor !== true && opts.draftOnly !== true) await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    const productIdFor = productId;
    const doc = await c.deliveryDocuments.create(dispatcher(), r.order.id, { lines: opts.lines === 'some' ? [{ productId: productIdFor, quantity: 1 }] : null });
    if (!doc.ok) throw new Error(doc.message);
    const d = c.deliveryDocuments;
    if (opts.draftOnly === true) return { deliveryId: doc.data.id, branchId, orderId: r.order.id, total: r.order.totalAmount, productName: '' };
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
    // Finance: a chart of accounts and the standard payment methods (one of them is cash), for the company the tests use.
    const ctx = { companyId, actor: { type: 'user' as const, id: 'tester' }, origin: { surface: 'test', action: 'run' } };
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' }).catch(() => undefined);
    await c.finance.paymentMethods.seedStandard(ctx);
    const methods = await db.select().from(schema.paymentMethods).where(eq(schema.paymentMethods.companyId, companyId));
    cashMethod = methods.find((m) => m.kind === 'cash')?.id ?? '';
    otherMethod = methods.find((m) => m.kind !== 'cash')?.id ?? '';
    const till = methods.find((m) => m.kind === 'cash');
    tillBankId = till?.balancingBankAccountId ?? '';
    const [ridersGl] = await db.insert(schema.glAccounts).values({ companyId, no: `119${tag}`.slice(0, 8), name: 'Cash with riders', type: 'posting', category: 'assets', normalBalance: 'debit' }).returning();
    const [overShort] = await db.insert(schema.glAccounts).values({ companyId, no: `699${tag}`.slice(0, 8), name: 'Cash over and short', type: 'posting', category: 'expense', normalBalance: 'debit' }).returning();
    varianceGl = overShort?.id ?? '';
    const ridersBank = await c.finance.bankAccounts.create(ctx, { code: `RC${tag}`, name: 'Cash with riders', kind: 'cash', currency: 'KES' });
    const created = await c.finance.paymentMethods.create(ctx, { code: `RIDERS${tag}`, name: 'Cash with riders', kind: 'cash', balancingBankAccountId: ridersBank.id, providerId: till?.providerId ?? '', glAccountId: ridersGl?.id ?? '', usableFor: ['customer_receipt'], settlementMode: 'immediate' });
    ridersMethod = created.id;
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
    const now = await c.doorPayments.settings(companyId);
    if (now.cashMethodId !== cashMethod) {
      const set = await c.doorPayments.setCashMethod(dispatcher(), { cashMethodId: cashMethod, expectedVersion: now.version });
      if (!set.ok) throw new Error(set.message);
    }
  });
  afterEach(async () => {
    // Riders made by one test must not count against the next test's choice of kinds.
    if (madeUsers.length > 0) await db.update(schema.deliveryRiders).set({ status: 'ended', statusReason: 'test over' }).where(inArray(schema.deliveryRiders.userId, madeUsers));
    if (madeBranches.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, madeBranches));
    if (madeLocations.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations));
  });

  const doorOf = async (deliveryId: string) => {
    const [d] = await db.select().from(schema.deliveries).where(eq(schema.deliveries.id, deliveryId));
    if (d === undefined) throw new Error('no delivery');
    return d;
  };
  const orderOf = async (orderId: string) => {
    const [o] = await db.select().from(schema.orders).where(eq(schema.orders.id, orderId));
    if (o === undefined) throw new Error('no order');
    return o;
  };
  const custodyOf = async (deliveryId: string) => await db.select().from(schema.cashCustodyEntries).where(eq(schema.cashCustodyEntries.deliveryId, deliveryId));

  describe('how cash at the door is received', () => {
    it('needs a payment method of kind cash that is switched on, is versioned and is logged', async () => {
      expect(await c.doorPayments.setCashMethod(dispatcher(), { cashMethodId: otherMethod })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringMatching(/kind cash/) as string });
      expect(await c.doorPayments.setCashMethod(dispatcher(), { cashMethodId: randomUUID() })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.doorPayments.setCashMethod(dispatcher(), { cashMethodId: '' })).toMatchObject({ ok: false, reason: 'bad_input' });
      const now = await c.doorPayments.settings(companyId);
      expect(await c.doorPayments.setCashMethod(dispatcher(), { cashMethodId: cashMethod, expectedVersion: now.version + 5 })).toMatchObject({ ok: false, reason: 'conflict' });
      expect(now).toMatchObject({ cashMethodId: cashMethod });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, companyId));
      expect(log.map((l) => l.action)).toContain('door_payments.method_set');
    });

    it('is needed before a delivery can be marked', async () => {
      await db.delete(schema.deliveryDoorSettings).where(eq(schema.deliveryDoorSettings.companyId, companyId));
      try {
        await expect(readyDelivery({ atDoor: true })).rejects.toThrow(/Door payments/);
      } finally {
        const set = await c.doorPayments.setCashMethod(dispatcher(), { cashMethodId: cashMethod });
        expect(set.ok).toBe(true);
      }
    });
  });

  describe('marking a delivery to be paid at the door', () => {
    it('sets the amount due from the order, lets it go out unpaid, and keeps who allowed it and why', async () => {
      const ready = await readyDelivery({ atDoor: true });
      const d = await doorOf(ready.deliveryId);
      expect(d.doorAmount).toBe(ready.total.toFixed(2));
      expect(d).toMatchObject({ doorMarkedBy: 'dispatcher-1', doorReason: 'Customer will pay when it arrives' });
      expect((await orderOf(ready.orderId)).paymentStatus).toBe('unpaid');
      const view = await c.deliveryDocuments.get(companyId, ready.deliveryId);
      expect(view?.door).toMatchObject({ amount: ready.total.toFixed(2), markedBy: 'dispatcher-1' });
      expect(view?.status).toBe('ready');
      expect(view?.events.map((e) => e.action)).toContain('door_marked');
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, ready.deliveryId));
      expect(log.map((l) => l.action)).toContain('delivery.door_marked');
    });

    it('an unpaid delivery that is not marked still cannot go out', async () => {
      const ready = await readyDelivery({ atDoor: true });
      expect((await c.doorPayments.unmark(dispatcher(), ready.deliveryId, { reason: 'Changed our mind' })).ok).toBe(true);
      expect((await doorOf(ready.deliveryId)).doorAmount).toBeNull();
      const rider = await staffRider();
      const run = await runFor(rider.id, ready.branchId);
      expect((await c.deliveryRuns.addStop(dispatcher(), run.id, ready.deliveryId)).ok).toBe(true);
      expect(await c.deliveryRuns.start(dispatcher(), run.id)).toMatchObject({ ok: false });
    });

    it('is refused for an order that is paid, on account, partly on this delivery, or not the shop\'s own rider, and needs a reason', async () => {
      const paid = await readyDelivery();
      expect(await c.doorPayments.mark(dispatcher(), paid.deliveryId, { reason: 'Please let it' })).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringMatching(/already has a payment/) as string });
      const some = await readyDelivery({ draftOnly: true, lines: 'some' });
      expect(await c.doorPayments.mark(dispatcher(), some.deliveryId, { reason: 'Please let it' })).toMatchObject({ ok: false, message: expect.stringMatching(/whole order/) as string });
      const fresh = await readyDelivery({ atDoor: true });
      expect(await c.doorPayments.mark(dispatcher(), fresh.deliveryId, { reason: 'Again please' })).toMatchObject({ ok: false, message: expect.stringMatching(/already marked/) as string });
      expect(await c.doorPayments.mark(dispatcher(), randomUUID(), { reason: 'Please let it' })).toMatchObject({ ok: false, reason: 'not_found' });
      const other = await readyDelivery();
      expect(await c.doorPayments.mark(dispatcher(), other.deliveryId, { reason: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
      // Taking it back needs a reason too, and is refused once the delivery has gone out.
      expect(await c.doorPayments.unmark(dispatcher(), fresh.deliveryId, { reason: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.doorPayments.unmark(dispatcher(), other.deliveryId, { reason: 'It was never marked' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });

    it('cannot be taken back once the delivery is out', async () => {
      const at = await onTheRoad(await staffRider(), { atDoor: true });
      expect(await c.doorPayments.unmark(dispatcher(), at.deliveryId, { reason: 'Too late now' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });
  });

  describe('the rider collects the cash', () => {
    it('must collect exactly what is due; then the delivery is delivered, the order is paid and the cash is in custody', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider, { atDoor: true });
      const stop = (await c.riderRuns.one(at.self, at.runId))?.items[0];
      expect(stop).toMatchObject({ collect: at.total.toFixed(2), open: true });
      const base = { runId: at.runId, deliveryId: at.deliveryId, receivedBy: 'Mama' };
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key() })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringMatching(/how much cash/) as string });
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key(), cashCollected: at.total - 1 })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining(at.total.toFixed(2)) as string });
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key(), cashCollected: at.total + 0.01 })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect((await orderOf(at.orderId)).paymentStatus).toBe('unpaid');
      expect((await attemptsOf(at.deliveryId)).length).toBe(0);

      const k = key();
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: k, cashCollected: at.total })).toMatchObject({ ok: true, data: { status: 'delivered' } });
      const order = await orderOf(at.orderId);
      expect(order).toMatchObject({ paymentStatus: 'paid', paymentMethodId: cashMethod, paymentMethod: 'cash_at_door' });
      const entries = await custodyOf(at.deliveryId);
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: 'collected', riderId: rider.id, orderId: at.orderId, key: `collect:${at.deliveryId}`, currency: 'KES' });
      expect(entries[0]?.amount).toBe(at.total.toFixed(2));
      const stages = await db.select().from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, at.orderId));
      expect(stages.find((s) => s.stage === 'payment_confirmed')).toMatchObject({ outcome: 'succeeded' });
      // The sale is queued for the books, as for any cash sale.
      const queued = await db.select().from(schema.financeSalesPostings).where(eq(schema.financeSalesPostings.subjectId, at.orderId));
      expect(queued.map((q) => q.kind)).toContain('cash_sale');
      // The same try sent again takes nothing twice.
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: k, cashCollected: at.total })).toMatchObject({ ok: true, data: { replayed: true } });
      expect(await custodyOf(at.deliveryId)).toHaveLength(1);
      // What the rider holds, for them and for the office.
      expect(await c.doorPayments.heldBy(at.self)).toBe(at.total.toFixed(2));
      const balance = (await c.doorPayments.balances(companyId, new Date().toISOString().slice(0, 10))).find((b) => b.riderId === rider.id);
      expect(balance).toMatchObject({ balance: at.total.toFixed(2), collectedToday: at.total.toFixed(2) });
      const ledger = await c.doorPayments.entries(companyId, { riderId: rider.id });
      expect(ledger.rows[0]).toMatchObject({ kind: 'collected', riderName: expect.any(String) as string, deliveryNumber: expect.any(String) as string });
    });

    it('is taken whole: part of it cannot be refused at a door that is paid there', async () => {
      const at = await onTheRoad(await staffRider(), { atDoor: true });
      const [line] = await db.select().from(schema.deliveryLines).where(eq(schema.deliveryLines.deliveryId, at.deliveryId));
      const r = await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', cashCollected: at.total, accepted: [{ productId: line?.productId, quantity: 1, reasonCode: 'damaged' }] });
      expect(r).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringMatching(/taken whole/) as string });
      expect((await doorOf(at.deliveryId)).status).toBe('out_for_delivery');
    });

    it('can still fail, and nothing is collected or paid', async () => {
      const at = await onTheRoad(await staffRider(), { atDoor: true });
      expect(await c.doorWork.fail(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), reasonCode: 'refused', note: 'Could not pay' })).toMatchObject({ ok: true, data: { status: 'failed_attempt' } });
      expect(await custodyOf(at.deliveryId)).toHaveLength(0);
      expect((await orderOf(at.orderId)).paymentStatus).toBe('unpaid');
    });

    it('is all or nothing: if the order was paid some other way meanwhile, the delivery is not marked delivered and no cash is taken', async () => {
      const at = await onTheRoad(await staffRider(), { atDoor: true });
      await OrderStages.move(db, at.orderId, 'payment_confirmed', 'succeeded', {});
      const r = await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', cashCollected: at.total });
      expect(r).toMatchObject({ ok: false, reason: 'conflict', message: expect.stringMatching(/already been paid/) as string });
      expect((await doorOf(at.deliveryId)).status).toBe('out_for_delivery');
      expect(await custodyOf(at.deliveryId)).toHaveLength(0);
      expect(await attemptsOf(at.deliveryId)).toHaveLength(0);
    });

    it('is refused when cash at the door is no longer set up', async () => {
      const at = await onTheRoad(await staffRider(), { atDoor: true });
      await db.update(schema.deliveryDoorSettings).set({ cashMethodId: null }).where(eq(schema.deliveryDoorSettings.companyId, companyId));
      try {
        expect(await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', cashCollected: at.total })).toMatchObject({ ok: false, message: expect.stringMatching(/not set up/) as string });
        expect((await doorOf(at.deliveryId)).status).toBe('out_for_delivery');
      } finally {
        await db.update(schema.deliveryDoorSettings).set({ cashMethodId: cashMethod }).where(eq(schema.deliveryDoorSettings.companyId, companyId));
      }
    });

    it('a delivery that is not marked asks for no cash', async () => {
      const at = await onTheRoad(await staffRider());
      expect((await c.riderRuns.one(at.self, at.runId))?.items[0]?.collect).toBeNull();
      expect(await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama' })).toMatchObject({ ok: true });
      expect(await custodyOf(at.deliveryId)).toHaveLength(0);
    });
  });

  describe('the custody ledger', () => {
    it('cannot be changed or removed, even straight in the database, and a collection is one per delivery', async () => {
      const at = await onTheRoad(await staffRider(), { atDoor: true });
      await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', cashCollected: at.total });
      const [e] = await custodyOf(at.deliveryId);
      await expect(db.update(schema.cashCustodyEntries).set({ amount: '1.00' }).where(eq(schema.cashCustodyEntries.id, e?.id ?? ''))).rejects.toThrow();
      await expect(db.delete(schema.cashCustodyEntries).where(eq(schema.cashCustodyEntries.id, e?.id ?? ''))).rejects.toThrow();
      await expect(db.insert(schema.cashCustodyEntries).values({ companyId, riderId: e?.riderId ?? '', kind: 'collected', amount: '5.00', currency: 'KES', deliveryId: at.deliveryId, orderId: at.orderId, key: `collect:${at.deliveryId}`, actorId: 'x' })).rejects.toThrow();
      await expect(db.insert(schema.cashCustodyEntries).values({ companyId, riderId: e?.riderId ?? '', kind: 'collected', amount: '-5.00', currency: 'KES', deliveryId: at.deliveryId, orderId: at.orderId, key: `other:${randomUUID()}`, actorId: 'x' })).rejects.toThrow();
    });

    it('is paged newest first, and finishing posting finds nothing left once every collection is queued', async () => {
      const rider = await staffRider();
      for (let i = 0; i < 2; i += 1) {
        const at = await onTheRoad(rider, { atDoor: true });
        await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', cashCollected: at.total });
        await c.doorWork.finish(at.self, at.runId);
      }
      const page = await c.doorPayments.entries(companyId, { riderId: rider.id });
      expect(page.rows.length).toBeGreaterThanOrEqual(2);
      expect(page.rows.map((r) => r.createdAt)).toEqual([...page.rows.map((r) => r.createdAt)].sort().reverse());
      expect(await c.doorPayments.finishPosting(companyId)).toMatchObject({ checked: expect.any(Number) as number });
    });
  });

  describe('handing the cash in', () => {
    const cashier = () => ({ companyId, userId: 'cashier-1' });
    const boss = () => ({ companyId, userId: 'boss-1' });
    let witnessId = '';
    const useRidersAccount = async (limit = 0) => {
      const now = await c.doorPayments.settings(companyId);
      const set = await c.doorPayments.setCashMethod(dispatcher(), { cashMethodId: ridersMethod, expectedVersion: now.version });
      if (!set.ok) throw new Error(set.message);
      const d = await c.doorHandIns.differences(companyId);
      const diff = await c.doorHandIns.setDifferences(dispatcher(), { varianceLimit: limit, varianceGlAccountId: varianceGl, expectedVersion: d.version });
      if (!diff.ok) throw new Error(diff.message);
    };
    /** A rider who has collected cash at a door (and so holds it), the way a rider does. */
    const holding = async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider, { atDoor: true });
      const r = await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', cashCollected: at.total });
      if (!r.ok) throw new Error(r.message);
      await c.doorWork.finish(at.self, at.runId);
      return { rider, held: at.total, self: at.self };
    };
    const hand = (riderId: string, counted: unknown, over: Record<string, unknown> = {}) => c.doorHandIns.record(cashier(), { riderId, counted, toBankAccountId: tillBankId, witnessUserId: witnessId, note: null, ...over });
    const balanceOf = async (riderId: string) => {
      const rows = await db.select().from(schema.cashCustodyEntries).where(eq(schema.cashCustodyEntries.riderId, riderId));
      return rows.reduce((n, r) => n + Math.round(Number(r.amount) * 100), 0) / 100;
    };

    beforeAll(async () => {
      const [w] = await db.insert(schema.users).values({ id: randomUUID(), email: `wit-${tag}@handin.test`, passwordHash: 'x', name: `Witness ${tag}`, role: 'super_admin' }).returning();
      witnessId = w?.id ?? '';
      madeUsers.push(witnessId);
    });
    beforeEach(async () => {
      await useRidersAccount(0);
    });
    afterAll(async () => {
      const now = await c.doorPayments.settings(companyId);
      await c.doorPayments.setCashMethod(dispatcher(), { cashMethodId: cashMethod, expectedVersion: now.version });
    });

    it('differences: a limit and an account, versioned, validated and logged', async () => {
      const d = await c.doorHandIns.differences(companyId);
      expect(d).toMatchObject({ varianceLimit: '0.00', varianceGlAccountId: varianceGl });
      expect(await c.doorHandIns.setDifferences(dispatcher(), { varianceLimit: -1, varianceGlAccountId: varianceGl })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.doorHandIns.setDifferences(dispatcher(), { varianceLimit: 10, varianceGlAccountId: randomUUID() })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.doorHandIns.setDifferences(dispatcher(), { varianceLimit: 10, varianceGlAccountId: varianceGl, expectedVersion: d.version + 9 })).toMatchObject({ ok: false, reason: 'conflict' });
      const ok = await c.doorHandIns.setDifferences(dispatcher(), { varianceLimit: 10, varianceGlAccountId: varianceGl, expectedVersion: d.version });
      expect(ok).toMatchObject({ ok: true, data: { varianceLimit: '10.00' } });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, companyId));
      expect(log.map((l) => l.action)).toContain('door_payments.differences_set');
    });

    it('an exact count posts at once: custody is nothing, the cash moves between the two accounts, and it is kept', async () => {
      const { rider, held } = await holding();
      expect(await balanceOf(rider.id)).toBe(held);
      const r = await hand(rider.id, held);
      expect(r).toMatchObject({ ok: true, data: { status: 'posted', difference: '0.00', counted: held.toFixed(2), expected: held.toFixed(2) } });
      expect(await balanceOf(rider.id)).toBe(0);
      const [h] = await db.select().from(schema.cashHandIns).where(eq(schema.cashHandIns.riderId, rider.id));
      expect(h).toMatchObject({ status: 'posted', witnessUserId: witnessId, countedBy: 'cashier-1' });
      const entries = await db.select().from(schema.cashCustodyEntries).where(eq(schema.cashCustodyEntries.handInId, h?.id ?? ''));
      expect(entries.map((e) => e.kind)).toEqual(['handed_in']);
      expect(entries[0]?.amount).toBe((-held).toFixed(2));
      const bank = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, h?.id ?? ''));
      expect(bank.map((b) => Number(b.amount)).sort((a, b) => a - b)).toEqual([-held, held]);
      expect(bank.find((b) => Number(b.amount) > 0)?.bankAccountId).toBe(tillBankId);
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, h?.id ?? ''));
      expect(log.map((l) => l.action)).toContain('door_payments.hand_in_recorded');
      expect(await c.doorPayments.heldBy(await selfOf(rider.userId))).toBe('0.00');
    });

    it('a difference within the limit posts at once, with its reason: the rider holds nothing and the difference is an adjustment', async () => {
      await useRidersAccount(50);
      const { rider, held } = await holding();
      expect(await hand(rider.id, held - 10)).toMatchObject({ ok: false, message: expect.stringMatching(/short by KSh 10.00/) as string });
      const r = await hand(rider.id, held - 10, { note: 'A note was torn and not accepted' });
      expect(r).toMatchObject({ ok: true, data: { status: 'posted', difference: '-10.00' } });
      expect(await balanceOf(rider.id)).toBe(0);
      const [h] = await db.select().from(schema.cashHandIns).where(eq(schema.cashHandIns.riderId, rider.id));
      const entries = await db.select().from(schema.cashCustodyEntries).where(eq(schema.cashCustodyEntries.handInId, h?.id ?? ''));
      expect(entries.map((e) => [e.kind, e.amount, e.note])).toEqual(expect.arrayContaining([['handed_in', (-(held - 10)).toFixed(2), null], ['adjusted', '-10.00', 'A note was torn and not accepted']]));
      const bank = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, h?.id ?? ''));
      // The riders' account is cleared of all they held; the till takes what was counted.
      expect(bank.map((b) => Number(b.amount)).sort((a, b) => a - b)).toEqual([-held, held - 10]);
      expect(h?.varianceGlAccountId).toBe(varianceGl);
    });

    it('an over count within the limit is the other way round', async () => {
      await useRidersAccount(50);
      const { rider, held } = await holding();
      const r = await hand(rider.id, held + 5, { note: 'The customer rounded up' });
      expect(r).toMatchObject({ ok: true, data: { status: 'posted', difference: '5.00' } });
      expect(await balanceOf(rider.id)).toBe(0);
    });

    it('a bigger difference waits: nothing posts and the rider still holds the cash, until another person approves it', async () => {
      const { rider, held } = await holding();
      const r = await hand(rider.id, held - 20, { note: 'Twenty shillings are missing' });
      expect(r).toMatchObject({ ok: true, data: { status: 'pending_approval', statusWords: 'Waiting for approval' } });
      const id = r.ok ? r.data.id : '';
      expect(await balanceOf(rider.id)).toBe(held);
      expect(await c.doorHandIns.waiting(companyId)).toBeGreaterThanOrEqual(1);
      expect(await hand(rider.id, held)).toMatchObject({ ok: false, reason: 'conflict' });
      expect(await c.doorHandIns.approve(cashier(), id)).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringMatching(/someone other/) as string });
      expect(await balanceOf(rider.id)).toBe(held);
      const done = await c.doorHandIns.approve(boss(), id);
      expect(done).toMatchObject({ ok: true, data: { status: 'posted', approvedBy: 'boss-1' } });
      expect(await balanceOf(rider.id)).toBe(0);
      expect(await c.doorHandIns.approve(boss(), id)).toMatchObject({ ok: false, reason: 'not_allowed' });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, id));
      expect(log.map((l) => l.action)).toEqual(expect.arrayContaining(['door_payments.hand_in_waiting', 'door_payments.hand_in_approved']));
    });

    it('can be refused with a reason, which frees the rider to be counted again', async () => {
      const { rider, held } = await holding();
      const r = await hand(rider.id, held - 30, { note: 'Thirty shillings are missing' });
      const id = r.ok ? r.data.id : '';
      expect(await c.doorHandIns.reject(boss(), id, { reason: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.doorHandIns.reject(boss(), id, { reason: 'Count it again with the rider present' })).toMatchObject({ ok: true, data: { status: 'rejected', decisionReason: 'Count it again with the rider present' } });
      expect(await balanceOf(rider.id)).toBe(held);
      expect(await hand(rider.id, held)).toMatchObject({ ok: true, data: { status: 'posted' } });
      expect(await balanceOf(rider.id)).toBe(0);
    });

    it('is refused for approval if the rider\'s cash changed while it waited', async () => {
      const rider = await staffRider();
      const first = await onTheRoad(rider, { atDoor: true });
      await c.doorWork.deliver(first.self, { runId: first.runId, deliveryId: first.deliveryId, clientKey: key(), receivedBy: 'A', cashCollected: first.total });
      await c.doorWork.finish(first.self, first.runId);
      const r = await hand(rider.id, first.total - 20, { note: 'Twenty shillings are missing' });
      const id = r.ok ? r.data.id : '';
      const second = await onTheRoad(rider, { atDoor: true });
      await c.doorWork.deliver(second.self, { runId: second.runId, deliveryId: second.deliveryId, clientKey: key(), receivedBy: 'B', cashCollected: second.total });
      const stale = await c.doorHandIns.approve(boss(), id);
      expect(stale).toMatchObject({ ok: false, reason: 'conflict', message: expect.stringMatching(/Refuse it and count again/) as string });
      expect(await c.doorHandIns.reject(boss(), id, { reason: 'More cash arrived since' })).toMatchObject({ ok: true });
    });

    it('once the books are live it is a balanced journal: the till takes what was counted, the riders\' account is cleared, a shortage goes to the difference account', async () => {
      await db.update(schema.financeSettings).set({ salesGlGoLive: '2026-01-01' }).where(eq(schema.financeSettings.companyId, companyId));
      try {
        await useRidersAccount(50);
        const { rider, held } = await holding();
        const r = await hand(rider.id, held - 10, { note: 'A note was torn and not accepted' });
        expect(r).toMatchObject({ ok: true, data: { status: 'posted' } });
        const [h] = await db.select().from(schema.cashHandIns).where(eq(schema.cashHandIns.riderId, rider.id));
        expect(h?.registerId).not.toBeNull();
        const lines = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, h?.registerId ?? ''));
        const sum = (rows: typeof lines, key: 'debit' | 'credit') => rows.reduce((n, l) => n + Math.round(Number(l[key]) * 100), 0);
        expect(sum(lines, 'debit')).toBe(sum(lines, 'credit'));
        expect(sum(lines, 'debit')).toBe(Math.round(held * 100));
        expect(lines.find((l) => l.accountId === varianceGl)).toMatchObject({ debit: '10.0000' });
        const [ridersGl] = await db.select({ gl: schema.paymentMethods.glAccountId }).from(schema.paymentMethods).where(eq(schema.paymentMethods.id, ridersMethod));
        expect(Number(lines.find((l) => l.accountId === ridersGl?.gl)?.credit)).toBe(held);
        // Counted exactly, there is no difference line at all.
        const second = await holding();
        const ok = await hand(second.rider.id, second.held);
        expect(ok).toMatchObject({ ok: true, data: { status: 'posted' } });
        const [h2] = await db.select().from(schema.cashHandIns).where(eq(schema.cashHandIns.riderId, second.rider.id));
        const lines2 = await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, h2?.registerId ?? ''));
        expect(lines2).toHaveLength(2);
      } finally {
        await db.update(schema.financeSettings).set({ salesGlGoLive: null }).where(eq(schema.financeSettings.companyId, companyId));
      }
    });

    it('is refused for what cannot be right', async () => {
      const { rider, held } = await holding();
      expect(await hand(rider.id, held, { witnessUserId: '' })).toMatchObject({ ok: false, message: expect.stringMatching(/witness/) as string });
      expect(await hand(rider.id, held, { witnessUserId: 'cashier-1' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await hand(rider.id, held, { toBankAccountId: '' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await hand(rider.id, held, { toBankAccountId: randomUUID() })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await hand(rider.id, 'ten')).toMatchObject({ ok: false, message: expect.stringMatching(/how much cash/) as string });
      expect(await hand(randomUUID(), held)).toMatchObject({ ok: false, reason: 'not_found' });
      const noOne = await staffRider();
      expect(await hand(noOne.id, 10)).toMatchObject({ ok: false, message: expect.stringMatching(/holds no cash/) as string });
      const [custodyBank] = await db.select({ b: schema.paymentMethods.balancingBankAccountId }).from(schema.paymentMethods).where(eq(schema.paymentMethods.id, ridersMethod));
      expect(await hand(rider.id, held, { toBankAccountId: custodyBank?.b })).toMatchObject({ ok: false, message: expect.stringMatching(/not the account riders/) as string });
      expect(await balanceOf(rider.id)).toBe(held);
    });

    it('is refused for a difference when no account is chosen for it', async () => {
      const { rider, held } = await holding();
      await db.update(schema.deliveryDoorSettings).set({ varianceGlAccountId: null }).where(eq(schema.deliveryDoorSettings.companyId, companyId));
      expect(await hand(rider.id, held - 5, { note: 'Five shillings short' })).toMatchObject({ ok: false, message: expect.stringMatching(/Differences/) as string });
      expect(await hand(rider.id, held)).toMatchObject({ ok: true });
    });

    it('is kept for good: a decided hand-in cannot be changed or removed, and a waiting one only decided', async () => {
      const { rider, held } = await holding();
      const waiting = await hand(rider.id, held - 20, { note: 'Twenty shillings are missing' });
      const wid = waiting.ok ? waiting.data.id : '';
      await expect(db.update(schema.cashHandIns).set({ countedAmount: '1.00', difference: '1.00' }).where(eq(schema.cashHandIns.id, wid))).rejects.toThrow();
      await c.doorHandIns.approve(boss(), wid);
      await expect(db.update(schema.cashHandIns).set({ note: 'edited' }).where(eq(schema.cashHandIns.id, wid))).rejects.toThrow();
      await expect(db.delete(schema.cashHandIns).where(eq(schema.cashHandIns.id, wid))).rejects.toThrow();
      const [entry] = await db.select().from(schema.cashCustodyEntries).where(eq(schema.cashCustodyEntries.handInId, wid));
      await expect(db.delete(schema.cashCustodyEntries).where(eq(schema.cashCustodyEntries.id, entry?.id ?? ''))).rejects.toThrow();
    });

    it('is listed newest first, by state, and riders with cash to hand in are offered', async () => {
      const { rider, held } = await holding();
      const withCash = await c.doorHandIns.ridersWithCash(companyId);
      expect(withCash.find((r) => r.riderId === rider.id)).toMatchObject({ held: held.toFixed(2) });
      const waiting = await hand(rider.id, held - 20, { note: 'Twenty shillings are missing' });
      const list = await c.doorHandIns.list(companyId, { status: 'pending_approval', riderId: rider.id });
      expect(list.rows.map((r) => r.id)).toEqual([waiting.ok ? waiting.data.id : '']);
      expect(list.rows[0]).toMatchObject({ riderName: expect.any(String) as string, witnessName: `Witness ${tag}`, toAccount: expect.stringContaining(' · ') as string });
      expect((await c.doorHandIns.list(companyId, {})).rows.length).toBeGreaterThanOrEqual(1);
      expect(await c.doorHandIns.ridersWithCash(companyId).then((r) => r.some((x) => x.riderId === rider.id))).toBe(true);
    });
  });

  describe('M-Pesa at the door', () => {
    let limited: string | null = null;
    let startFails = false;
    let started = 0;
    /** The shop's own payment start, stood in for: it makes the attempt row the engine would, with the order and number it was given. */
    const fakeStart = async (input: { orderId: string; payerPhone: string }) => {
      if (startFails) throw new Error('provider down');
      started += 1;
      const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, input.orderId));
      const [provider] = await db.select().from(schema.paymentProviderConfigs).where(eq(schema.paymentProviderConfigs.companyId, companyId));
      const [branchRow] = await db.select({ id: schema.branches.id }).from(schema.branches).where(eq(schema.branches.companyId, companyId));
      const [attempt] = await db
        .insert(schema.paymentAttempts)
        .values({ branchId: branchRow?.id ?? '', providerConfigId: provider?.id ?? '', providerCode: 'mpesa_daraja', orderId: input.orderId, orderNumber: order?.orderNumber ?? '', amount: order?.totalAmount ?? '0.00', callbackToken: randomUUID(), callbackUrl: 'http://localhost/cb', status: 'pending', customerPhone: input.payerPhone })
        .returning();
      return { attemptId: attempt?.id ?? '', status: 'pending', customerMessage: 'Enter your PIN.' };
    };
    const mpesa = () => new DoorMpesa(db, { start: fakeStart, amountDue: async (id) => { const [o] = await db.select({ t: schema.orders.totalAmount, tendered: schema.orders.tenderedAmount }).from(schema.orders).where(eq(schema.orders.id, id)); return o === undefined ? null : Number(o.t) - Number(o.tendered); }, limit: () => Promise.resolve(limited) });
    const ask = (at: { runId: string; deliveryId: string; self: Awaited<ReturnType<typeof selfOf>> }, phone: unknown = '0712 345 678') => mpesa().prompt(at.self, { runId: at.runId, deliveryId: at.deliveryId, phone });
    const attemptRows = async (orderId: string) => await db.select().from(schema.paymentAttempts).where(eq(schema.paymentAttempts.orderId, orderId));
    const confirm = async (orderId: string) => {
      await db.update(schema.paymentAttempts).set({ status: 'successful', paidAt: new Date() }).where(eq(schema.paymentAttempts.orderId, orderId));
      await OrderStages.move(db, orderId, 'payment_confirmed', 'succeeded', { source: 'webhook', detail: { provider: 'mpesa_daraja' } });
    };

    beforeEach(() => {
      limited = null;
      startFails = false;
      started = 0;
    });

    it('sends a prompt for what is due at this door, once at a time, to a number the customer says, and keeps who asked', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider, { atDoor: true });
      const sent = await ask(at, '0712 345 678');
      expect(sent).toMatchObject({ ok: true, data: { state: 'waiting', phoneEnding: '678', promptsLeft: 2 } });
      const [attempt] = await attemptRows(at.orderId);
      expect(attempt).toMatchObject({ providerCode: 'mpesa_daraja', customerPhone: '254712345678', status: 'pending' });
      const [prompt] = await db.select().from(schema.deliveryDoorPrompts).where(eq(schema.deliveryDoorPrompts.deliveryId, at.deliveryId));
      expect(prompt).toMatchObject({ riderId: rider.id, orderId: at.orderId, phoneEnding: '678', attemptId: attempt?.id, amount: at.total.toFixed(2) });
      // The books find an M-Pesa method by what the order says it is paid with.
      expect(await orderOf(at.orderId)).toMatchObject({ paymentMethod: 'mpesa_daraja', paymentMethodId: null });
      expect(await mpesa().status(at.self, { runId: at.runId, deliveryId: at.deliveryId })).toMatchObject({ ok: true, data: { state: 'waiting', phoneEnding: '678' } });
      expect(await ask(at)).toMatchObject({ ok: false, message: expect.stringMatching(/just sent/) as string });
      expect(started).toBe(1);
      await expect(db.delete(schema.deliveryDoorPrompts).where(eq(schema.deliveryDoorPrompts.deliveryId, at.deliveryId))).rejects.toThrow();
    });

    it('says when it did not go through, allows another prompt, and stops after three', async () => {
      const at = await onTheRoad(await staffRider(), { atDoor: true });
      for (let i = 0; i < 3; i += 1) {
        expect(await ask(at)).toMatchObject({ ok: true });
        await db.update(schema.paymentAttempts).set({ status: i === 0 ? 'cancelled' : 'expired' }).where(eq(schema.paymentAttempts.orderId, at.orderId));
        const st = await mpesa().status(at.self, { runId: at.runId, deliveryId: at.deliveryId });
        expect(st).toMatchObject({ ok: true, data: { state: 'failed' } });
        expect(st.ok && st.data.message).toMatch(i === 0 ? /cancelled/ : /timed out/);
      }
      expect(await ask(at)).toMatchObject({ ok: false, message: expect.stringMatching(/Take the cash instead/) as string });
      expect(started).toBe(3);
    });

    it('when the platform confirms it the order is paid and the rider takes no cash: nothing enters their custody', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider, { atDoor: true });
      await ask(at);
      expect(await mpesa().status(at.self, { runId: at.runId, deliveryId: at.deliveryId })).toMatchObject({ data: { state: 'waiting' } });
      await confirm(at.orderId);
      expect(await mpesa().status(at.self, { runId: at.runId, deliveryId: at.deliveryId })).toMatchObject({ ok: true, data: { state: 'paid' } });
      expect((await c.riderRuns.one(at.self, at.runId))?.items[0]).toMatchObject({ paid: true, collect: at.total.toFixed(2) });
      const base = { runId: at.runId, deliveryId: at.deliveryId, receivedBy: 'Mama' };
      // Claiming cash for an order that is already paid is refused, and nothing changes.
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key(), cashCollected: at.total })).toMatchObject({ ok: false, reason: 'conflict', message: expect.stringMatching(/already been paid/) as string });
      expect((await doorOf(at.deliveryId)).status).toBe('out_for_delivery');
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key() })).toMatchObject({ ok: true, data: { status: 'delivered' } });
      expect(await custodyOf(at.deliveryId)).toHaveLength(0);
      expect(await c.doorPayments.heldBy(at.self)).toBe('0.00');
      expect((await orderOf(at.orderId)).paymentStatus).toBe('paid');
    });

    it('a door delivery whose order was paid some other way meanwhile is delivered with no cash, and a part taken is still refused', async () => {
      const at = await onTheRoad(await staffRider(), { atDoor: true });
      await OrderStages.move(db, at.orderId, 'payment_confirmed', 'succeeded', {});
      const [line] = await db.select().from(schema.deliveryLines).where(eq(schema.deliveryLines.deliveryId, at.deliveryId));
      const base = { runId: at.runId, deliveryId: at.deliveryId, receivedBy: 'Mama' };
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key(), accepted: [{ productId: line?.productId, quantity: 1, reasonCode: 'damaged' }] })).toMatchObject({ ok: false, message: expect.stringMatching(/taken whole/) as string });
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key() })).toMatchObject({ ok: true });
      expect(await custodyOf(at.deliveryId)).toHaveLength(0);
    });

    it('is refused for what cannot be right', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider, { atDoor: true });
      const other = await selfOf((await staffRider()).userId);
      expect(await mpesa().prompt(other, { runId: at.runId, deliveryId: at.deliveryId, phone: '0712345678' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await mpesa().status(other, { runId: at.runId, deliveryId: at.deliveryId })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await mpesa().prompt(at.self, { runId: 'nope', deliveryId: at.deliveryId })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await ask(at, 'not a number')).toMatchObject({ ok: false, message: expect.stringMatching(/number the customer will pay from/) as string });
      limited = 'Too many prompts. Wait a few minutes.';
      expect(await ask(at)).toMatchObject({ ok: false, message: 'Too many prompts. Wait a few minutes.' });
      limited = null;
      startFails = true;
      expect(await ask(at)).toMatchObject({ ok: false, message: expect.stringMatching(/could not be sent/) as string });
      expect(started).toBe(0);
      const plain = await onTheRoad(rider);
      expect(await ask(plain)).toMatchObject({ ok: false, message: expect.stringMatching(/not to be paid at the door/) as string });
    });
  });
});
