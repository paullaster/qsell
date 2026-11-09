import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
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

describe.skipIf(!has(url))('rider pay in the books (database)', () => {
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
  // For hand-ins: a method of its own whose account stands for cash with riders, the till cash goes into, and where differences are written.
  const tag = randomUUID().slice(0, 6).toUpperCase();
  let n = 0;
  const code = () => `BK${tag}${String((n += 1)).padStart(3, '0')}`;
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
  const onTheRoad = async (rider: { id: string; userId: string }, opts: { atDoor?: boolean; pod?: boolean } = {}) => {
    const ready = await readyDelivery(opts);
    const run = await runFor(rider.id, ready.branchId);
    const added = await c.deliveryRuns.addStop(dispatcher(), run.id, ready.deliveryId);
    if (!added.ok) throw new Error(added.message);
    const started = await c.deliveryRuns.start(dispatcher(), run.id);
    if (!started.ok) throw new Error(started.message);
    return { runId: run.id, deliveryId: ready.deliveryId, orderId: ready.orderId, total: ready.total, self: await selfOf(rider.userId) };
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
  const today = () => new Date().toISOString().slice(0, 10);
  const runFor = async (riderId: string, branchId: string) => {
    const r = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId });
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };

  /** A placed, paid order delivered by the shop's own riders from a branch that holds the goods, with a delivery ready to go on a run. */
  const readyDelivery = async (opts: { atDoor?: boolean; lines?: 'some'; draftOnly?: boolean; pod?: boolean } = {}) => {
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
      items: [{ productId, quantity: 3 }], currency: 'KES', paymentMethod: opts.pod === true ? 'pay_on_delivery' : 'mpesa_daraja', delivery: { method: 'own_fleet', pin: PIN },
    });
    if (!r.success || r.order === undefined) throw new Error(r.error);
    if (opts.atDoor !== true && opts.draftOnly !== true && opts.pod !== true) await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    const productIdFor = productId;
    const doc = await c.deliveryDocuments.create(dispatcher(), r.order.id, { lines: opts.lines === 'some' ? [{ productId: productIdFor, quantity: 1 }] : null });
    if (!doc.ok) throw new Error(doc.message);
    const d = c.deliveryDocuments;
    if (opts.draftOnly === true) return { deliveryId: doc.data.id, branchId, orderId: r.order.id, total: r.order.totalAmount, productName: '', productId };
    if (opts.pod === true) {
      // As the delivery screen does when the office makes the delivery: an order the customer chose to pay on delivery is marked as it is made.
      const marked = await c.doorPayments.markIfPayOnDelivery(dispatcher(), doc.data.id);
      if (marked?.ok !== true) throw new Error(marked?.ok === false ? marked.message : 'not a pay on delivery order');
    }
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
    return { deliveryId: doc.data.id, branchId, orderId: r.order.id, total: r.order.totalAmount, productName: `Carried ${productId.slice(-6)}`, productId };
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
    const rest = await db.select({ id: schema.chargePolicies.id }).from(schema.chargePolicies).where(like(schema.chargePolicies.code, `BK${tag}%`));
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

  let expenseGl = '';
  let payableGl = '';
  const setPay = async (perDelivery: number, perDay: number) => {
    const now = await c.deliveryCosts.pay(companyId);
    const r = await c.deliveryCosts.setPay(dispatcher(), { perDelivery, perDay, expectedVersion: now.version });
    if (!r.ok) throw new Error(r.message);
  };
  const setAccounts = async () => {
    const now = await c.deliveryCostBooks.accounts(companyId);
    const r = await c.deliveryCostBooks.setAccounts(dispatcher(), { expenseGlAccountId: expenseGl, payableGlAccountId: payableGl, expectedVersion: now.version });
    if (!r.ok) throw new Error(r.message);
  };
  const goLive = async (on: boolean) => {
    await db.update(schema.financeSettings).set({ salesGlGoLive: on ? '2026-01-01' : null }).where(eq(schema.financeSettings.companyId, companyId));
  };
  const earn = async (rider: { id: string; userId: string }) => {
    const at = await onTheRoad(rider);
    const r = await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama' });
    if (!r.ok) throw new Error(r.message);
    return at;
  };
  const costsOf = async (riderId: string) => await db.select().from(schema.deliveryCosts).where(eq(schema.deliveryCosts.riderId, riderId));
  const linesOf = async (registerId: string | null) => await db.select().from(schema.glEntries).where(eq(schema.glEntries.registerId, registerId ?? ''));
  const sum = (rows: Awaited<ReturnType<typeof linesOf>>, key: 'debit' | 'credit') => rows.reduce((n, l) => n + Math.round(Number(l[key]) * 100), 0);
  const postingOf = async (costId: string) => (await db.select().from(schema.deliveryCostPostings).where(eq(schema.deliveryCostPostings.costId, costId)))[0];
  const clean = async () => {
    // What earlier tests left owed or unposted must not leak into the next: every rider's costs are paid out or posted as a test needs.
    await db.update(schema.deliveryRiders).set({ status: 'ended', statusReason: 'test over' }).where(inArray(schema.deliveryRiders.userId, madeUsers));
  };

  beforeAll(async () => {
    requirePermission.mockReset().mockResolvedValue('dispatcher-1');
    const [e] = await db.insert(schema.glAccounts).values({ companyId, no: `627${tag}`.slice(0, 8), name: 'Rider pay', type: 'posting', category: 'expense', normalBalance: 'debit' }).returning();
    const [p] = await db.insert(schema.glAccounts).values({ companyId, no: `219${tag}`.slice(0, 8), name: 'Owed to riders', type: 'posting', category: 'liabilities', normalBalance: 'credit' }).returning();
    expenseGl = e?.id ?? '';
    payableGl = p?.id ?? '';
    await setPay(50, 0);
  });
  afterAll(async () => {
    await goLive(false);
    await clean();
  });

  describe('the accounts', () => {
    it('are two different open accounts that take postings, versioned and logged', async () => {
      const now = await c.deliveryCostBooks.accounts(companyId);
      expect(await c.deliveryCostBooks.setAccounts(dispatcher(), { expenseGlAccountId: expenseGl })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryCostBooks.setAccounts(dispatcher(), { expenseGlAccountId: expenseGl, payableGlAccountId: expenseGl })).toMatchObject({ ok: false, message: expect.stringMatching(/two different/) as string });
      expect(await c.deliveryCostBooks.setAccounts(dispatcher(), { expenseGlAccountId: expenseGl, payableGlAccountId: randomUUID() })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.deliveryCostBooks.setAccounts(dispatcher(), { expenseGlAccountId: expenseGl, payableGlAccountId: payableGl, expectedVersion: now.version + 9 })).toMatchObject({ ok: false, reason: 'conflict' });
      const [heading] = await db.insert(schema.glAccounts).values({ companyId, no: `1H${tag}`.slice(0, 8), name: 'A heading', type: 'heading', normalBalance: 'debit' }).returning();
      expect(await c.deliveryCostBooks.setAccounts(dispatcher(), { expenseGlAccountId: expenseGl, payableGlAccountId: heading?.id, expectedVersion: now.version })).toMatchObject({ ok: false, message: expect.stringMatching(/open accounts/) as string });
      const ok = await c.deliveryCostBooks.setAccounts(dispatcher(), { expenseGlAccountId: expenseGl, payableGlAccountId: payableGl, expectedVersion: now.version });
      expect(ok).toMatchObject({ ok: true, data: { expenseGlAccountId: expenseGl, payableGlAccountId: payableGl } });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, companyId));
      expect(log.map((l) => l.action)).toContain('delivery_pay.accounts_set');
    });
  });

  describe('posting what was earned', () => {
    it('waits while the books are not live, then posts once: a cost owed to the rider, balanced', async () => {
      await goLive(false);
      const rider = await staffRider();
      await earn(rider);
      const [cost] = await costsOf(rider.id);
      expect(await c.deliveryCostBooks.processDue(500)).toMatchObject({ posted: 0 });
      expect(await postingOf(cost?.id ?? '')).toBeUndefined();
      await goLive(true);
      const done = await c.deliveryCostBooks.processDue(500);
      expect(done.posted).toBeGreaterThanOrEqual(1);
      const posting = await postingOf(cost?.id ?? '');
      expect(posting).toMatchObject({ status: 'posted' });
      const lines = await linesOf(posting?.registerId ?? null);
      expect(sum(lines, 'debit')).toBe(5000);
      expect(sum(lines, 'credit')).toBe(5000);
      expect(Number(lines.find((l) => l.accountId === expenseGl)?.debit)).toBe(50);
      expect(Number(lines.find((l) => l.accountId === payableGl)?.credit)).toBe(50);
      // Posting again posts nothing more.
      expect((await c.deliveryCostBooks.processDue(500)).posted).toBe(0);
      expect(await c.deliveryCostBooks.unposted(companyId)).toBe(0);
    });

    it('a cost taken back is posted the other way', async () => {
      await goLive(true);
      const rider = await staffRider();
      await earn(rider);
      const [cost] = await costsOf(rider.id);
      expect((await c.deliveryCosts.reverse(dispatcher(), cost?.id ?? '', { reason: 'It was not this rider\'s delivery' })).ok).toBe(true);
      await c.deliveryCostBooks.processDue(500);
      const reversal = (await costsOf(rider.id)).find((x) => x.reversesId !== null);
      const lines = await linesOf((await postingOf(reversal?.id ?? ''))?.registerId ?? null);
      expect(Number(lines.find((l) => l.accountId === payableGl)?.debit)).toBe(50);
      expect(Number(lines.find((l) => l.accountId === expenseGl)?.credit)).toBe(50);
    });

    it('a failed posting is kept with its reason and tried again later, never losing the cost', async () => {
      await goLive(true);
      const rider = await staffRider();
      await earn(rider);
      const [cost] = await costsOf(rider.id);
      await db.update(schema.glAccounts).set({ blocked: true }).where(eq(schema.glAccounts.id, payableGl));
      try {
        const bad = await c.deliveryCostBooks.processDue(500);
        expect(bad.failed).toBeGreaterThanOrEqual(1);
        const failed = await postingOf(cost?.id ?? '');
        expect(failed).toMatchObject({ status: 'failed', attempts: 1 });
        expect(failed?.lastError).toBeTruthy();
        expect(failed?.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
        // Not tried again before its time.
        expect((await c.deliveryCostBooks.processDue(500)).failed).toBe(0);
      } finally {
        await db.update(schema.glAccounts).set({ blocked: false }).where(eq(schema.glAccounts.id, payableGl));
      }
      await db.update(schema.deliveryCostPostings).set({ nextAttemptAt: new Date(Date.now() - 1000) }).where(eq(schema.deliveryCostPostings.costId, cost?.id ?? ''));
      expect((await c.deliveryCostBooks.processDue(500)).posted).toBeGreaterThanOrEqual(1);
      expect(await postingOf(cost?.id ?? '')).toMatchObject({ status: 'posted' });
    });
  });

  describe("a rider's own pay", () => {
    it('shows only their own earnings, what is owed, what was taken back without the office\'s reason, and what was paid', async () => {
      await goLive(true);
      const rider = await staffRider();
      const other = await staffRider();
      await earn(rider);
      await earn(rider);
      await earn(other);
      const me = await selfOf(rider.userId);
      const before = await c.riderPay.mine(me);
      expect(before.owed).toBe('100.00');
      expect(before.earnedThisMonth).toBe('100.00');
      expect(before.entries).toHaveLength(2);
      expect(before.entries.every((e) => !e.paid && !e.takenBack && e.deliveryNumber !== null)).toBe(true);
      expect(before.payouts).toEqual([]);
      // Another rider's pay is not in it, and theirs does not show mine.
      expect((await c.riderPay.mine(await selfOf(other.userId))).owed).toBe('50.00');
      // The office takes one back for its own reason: the rider sees that it was taken back, not why.
      const first = before.entries[0];
      expect((await c.deliveryCosts.reverse(dispatcher(), first?.id ?? '', { reason: 'Internal: wrong rider on the run' })).ok).toBe(true);
      const after = await c.riderPay.mine(me);
      expect(after.owed).toBe('50.00');
      expect(after.entries.filter((e) => e.takenBack)).toHaveLength(1);
      expect(JSON.stringify(after)).not.toContain('wrong rider');
      expect(after.entries.find((e) => e.takenBack)?.words).toBe('Taken back by the office');
      // Paid: nothing owed, the entries say paid, and the payout is listed with how it was paid.
      const paid = await c.deliveryCostBooks.pay(dispatcher(), { riderId: rider.id, paymentMethodId: cashMethod, reference: 'SLIP-RIDER-1' });
      expect(paid.ok).toBe(true);
      const done = await c.riderPay.mine(me);
      expect(done.owed).toBe('0.00');
      expect(done.earnedThisMonth).toBe('50.00');
      expect(done.entries.every((e) => e.paid)).toBe(true);
      expect(done.payouts).toHaveLength(1);
      expect(done.payouts[0]).toMatchObject({ amount: '50.00', reference: 'SLIP-RIDER-1' });
      expect(done.payouts[0]?.number).toMatch(/^RPY-/);
    });

    it('is empty and says so for a rider who has earned nothing', async () => {
      const rider = await staffRider();
      expect(await c.riderPay.mine(await selfOf(rider.userId))).toMatchObject({ owed: '0.00', earnedThisMonth: '0.00', entries: [], payouts: [], moreEntries: false });
    });
  });

  describe('what is owed, and paying it', () => {
    it('is the pay earned less anything taken back, for each rider, and paying clears it once', async () => {
      await goLive(true);
      const rider = await staffRider();
      await earn(rider);
      await earn(rider);
      const owed = (await c.deliveryCostBooks.owed(companyId)).find((o) => o.riderId === rider.id);
      expect(owed).toMatchObject({ owed: '100.00', entries: 2 });
      const base = { riderId: rider.id, paymentMethodId: cashMethod };
      expect(await c.deliveryCostBooks.pay(dispatcher(), { ...base, riderId: 'nope' })).toMatchObject({ ok: false, reason: 'bad_input' });
      // A method that does not pay in cash, M-Pesa or through the bank (a cheque or a card) cannot pay a rider.
      const [unfit] = await db.select({ id: schema.paymentMethods.id }).from(schema.paymentMethods).where(and(eq(schema.paymentMethods.companyId, companyId), inArray(schema.paymentMethods.kind, ['cheque', 'card', 'gateway', 'wallet', 'gift_card', 'offset', 'other'])));
      expect(unfit).toBeDefined();
      expect(await c.deliveryCostBooks.pay(dispatcher(), { ...base, paymentMethodId: unfit?.id })).toMatchObject({ ok: false, message: expect.stringMatching(/cash, M-Pesa or through the bank/) as string });
      expect(await c.deliveryCostBooks.pay(dispatcher(), { ...base, paidOn: '2099-01-01' })).toMatchObject({ ok: false, message: expect.stringMatching(/has not come/) as string });
      expect(await c.deliveryCostBooks.pay(dispatcher(), { riderId: randomUUID(), paymentMethodId: cashMethod })).toMatchObject({ ok: false, reason: 'not_found' });
      // Paid: the earned entries were not yet in the books, so they are posted first, in the same transaction.
      const paid = await c.deliveryCostBooks.pay(dispatcher(), { ...base, reference: 'SLIP-1', note: 'Friday pay' });
      expect(paid).toMatchObject({ ok: true, data: { amount: '100.00', reference: 'SLIP-1', riderName: expect.any(String) as string } });
      const payoutId = paid.ok ? paid.data.id : '';
      const [payout] = await db.select().from(schema.deliveryPayPayouts).where(eq(schema.deliveryPayPayouts.id, payoutId));
      expect(payout).toMatchObject({ paymentMethodId: cashMethod, paidBy: 'dispatcher-1', currency: 'KES' });
      expect(await db.select().from(schema.deliveryPayPayoutItems).where(eq(schema.deliveryPayPayoutItems.payoutId, payoutId))).toHaveLength(2);
      const lines = await linesOf(payout?.registerId ?? null);
      expect(sum(lines, 'debit')).toBe(10000);
      expect(sum(lines, 'credit')).toBe(10000);
      expect(Number(lines.find((l) => l.accountId === payableGl)?.debit)).toBe(100);
      const bank = await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, payoutId));
      expect(bank).toHaveLength(1);
      expect(Number(bank[0]?.amount)).toBe(-100);
      expect((await c.deliveryCostBooks.owed(companyId)).some((o) => o.riderId === rider.id)).toBe(false);
      expect(await c.deliveryCostBooks.pay(dispatcher(), base)).toMatchObject({ ok: false, message: expect.stringMatching(/Nothing is owed/) as string });
      const listed = await c.deliveryCostBooks.payouts(companyId, { riderId: rider.id });
      expect(listed.rows.map((r) => r.id)).toEqual([payoutId]);
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, payoutId));
      expect(log.map((l) => l.action)).toContain('delivery_pay.paid');
    });

    it('a cost taken back after pay was handed over is set against the next pay', async () => {
      await goLive(true);
      const rider = await staffRider();
      const at = await earn(rider);
      expect((await c.deliveryCostBooks.pay(dispatcher(), { riderId: rider.id, paymentMethodId: cashMethod })).ok).toBe(true);
      const [cost] = (await costsOf(rider.id)).filter((x) => x.deliveryId === at.deliveryId);
      expect((await c.deliveryCosts.reverse(dispatcher(), cost?.id ?? '', { reason: 'Paid for a delivery they did not make' })).ok).toBe(true);
      expect((await c.deliveryCostBooks.owed(companyId)).find((o) => o.riderId === rider.id)).toMatchObject({ owed: '-50.00' });
      expect(await c.deliveryCostBooks.pay(dispatcher(), { riderId: rider.id, paymentMethodId: cashMethod })).toMatchObject({ ok: false, message: expect.stringMatching(/set against their next pay/) as string });
      await earn(rider);
      await earn(rider);
      expect((await c.deliveryCostBooks.owed(companyId)).find((o) => o.riderId === rider.id)).toMatchObject({ owed: '50.00', entries: 3 });
      expect(await c.deliveryCostBooks.pay(dispatcher(), { riderId: rider.id, paymentMethodId: cashMethod })).toMatchObject({ ok: true, data: { amount: '50.00' } });
    });

    it('works before the books are live: the bank ledger moves and no journal is made', async () => {
      await goLive(false);
      const rider = await staffRider();
      await earn(rider);
      const paid = await c.deliveryCostBooks.pay(dispatcher(), { riderId: rider.id, paymentMethodId: cashMethod });
      expect(paid).toMatchObject({ ok: true, data: { amount: '50.00' } });
      const [payout] = await db.select().from(schema.deliveryPayPayouts).where(eq(schema.deliveryPayPayouts.id, paid.ok ? paid.data.id : ''));
      expect(payout?.registerId).toBeNull();
      expect(await db.select().from(schema.bankLedgerEntries).where(eq(schema.bankLedgerEntries.documentId, payout?.id ?? ''))).toHaveLength(1);
    });

    it('is refused when the books are live and the accounts are not chosen', async () => {
      await goLive(true);
      const rider = await staffRider();
      await earn(rider);
      await db.update(schema.deliveryPaySettings).set({ expenseGlAccountId: null, payableGlAccountId: null }).where(eq(schema.deliveryPaySettings.companyId, companyId));
      try {
        expect(await c.deliveryCostBooks.pay(dispatcher(), { riderId: rider.id, paymentMethodId: cashMethod })).toMatchObject({ ok: false, message: expect.stringMatching(/Choose the accounts rider pay is booked to/) as string });
      } finally {
        await setAccounts();
      }
    });

    it('a payout and what it paid are kept for good', async () => {
      await goLive(false);
      const rider = await staffRider();
      await earn(rider);
      const paid = await c.deliveryCostBooks.pay(dispatcher(), { riderId: rider.id, paymentMethodId: cashMethod });
      const id = paid.ok ? paid.data.id : '';
      await expect(db.update(schema.deliveryPayPayouts).set({ amount: '1.00' }).where(eq(schema.deliveryPayPayouts.id, id))).rejects.toThrow();
      await expect(db.delete(schema.deliveryPayPayouts).where(eq(schema.deliveryPayPayouts.id, id))).rejects.toThrow();
      await expect(db.delete(schema.deliveryPayPayoutItems).where(eq(schema.deliveryPayPayoutItems.payoutId, id))).rejects.toThrow();
    });
  });
});
