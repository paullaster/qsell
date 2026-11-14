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

describe.skipIf(!has(url))('riders (database)', () => {
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
  const code = () => `RD${tag}${String((n += 1)).padStart(3, '0')}`;
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
  const staffRider = async (over: { phone?: string } = {}) => {
    const userId = await person('super_admin');
    const r = await c.deliveryRiders.addStaff(dispatcher(), { userId, ...over });
    if (!r.ok) throw new Error(r.message);
    return { id: r.data.id, userId };
  };
  const ownRider = async (email = `own-${randomUUID()}@riders.test`) => {
    const r = await c.deliveryRiders.createSeparate(dispatcher(), { name: 'Achieng Rider', email, phone: '0722 000 111', password: 'a-good-password' });
    if (!r.ok) throw new Error(r.message);
    const [rider] = await db.select().from(schema.deliveryRiders).where(eq(schema.deliveryRiders.id, r.data.id));
    if (rider === undefined) throw new Error('rider not saved');
    madeUsers.push(rider.userId);
    return { id: r.data.id, userId: rider.userId, email };
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
  const readyDelivery = async () => {
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
    await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    const doc = await c.deliveryDocuments.create(dispatcher(), r.order.id, { lines: null });
    if (!doc.ok) throw new Error(doc.message);
    const d = c.deliveryDocuments;
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
    return { deliveryId: doc.data.id, branchId, productName: `Carried ${productId.slice(-6)}` };
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
    const rest = await db.select({ id: schema.chargePolicies.id }).from(schema.chargePolicies).where(like(schema.chargePolicies.code, `RD${tag}%`));
    if (rest.length > 0) {
      await db.delete(schema.chargePolicyRates).where(inArray(schema.chargePolicyRates.policyId, rest.map((r) => r.id)));
      await db.delete(schema.chargePolicies).where(inArray(schema.chargePolicies.id, rest.map((r) => r.id)));
    }
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(async () => {
    requirePermission.mockReset().mockResolvedValue('dispatcher-1');
    await kinds(true, true);
  });
  afterEach(async () => {
    // Riders made by one test must not count against the next test's choice of kinds.
    if (madeUsers.length > 0) await db.update(schema.deliveryRiders).set({ status: 'ended', statusReason: 'test over' }).where(inArray(schema.deliveryRiders.userId, madeUsers));
    if (madeBranches.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, madeBranches));
    if (madeLocations.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations));
  });

  describe('which kinds of rider a company uses', () => {
    it('starts with staff only, and records a change to both', async () => {
      await db.delete(schema.deliveryRiderSettings).where(eq(schema.deliveryRiderSettings.companyId, companyId));
      expect(await c.deliveryRiders.settings(companyId)).toMatchObject({ allowStaff: true, allowSeparate: false, version: 0 });
      const r = await c.deliveryRiders.setKinds(dispatcher(), { allowStaff: true, allowSeparate: true });
      expect(r.ok && r.data).toMatchObject({ allowStaff: true, allowSeparate: true });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, companyId));
      expect(log.map((l) => l.action)).toContain('riders.kinds_set');
    });

    it('needs at least one kind, and refuses a stale version', async () => {
      const now = await c.deliveryRiders.settings(companyId);
      expect(await c.deliveryRiders.setKinds(dispatcher(), { allowStaff: false, allowSeparate: false, expectedVersion: now.version })).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(await c.deliveryRiders.setKinds(dispatcher(), { allowStaff: true, allowSeparate: false, expectedVersion: now.version + 5 })).toMatchObject({ ok: false, reason: 'conflict' });
    });

    it('cannot switch a kind off while people of that kind are riding', async () => {
      await staffRider();
      await ownRider();
      const now = await c.deliveryRiders.settings(companyId);
      const noStaff = await c.deliveryRiders.setKinds(dispatcher(), { allowStaff: false, allowSeparate: true, expectedVersion: now.version });
      expect(noStaff).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(!noStaff.ok && noStaff.message).toMatch(/still riding/);
      const noOwn = await c.deliveryRiders.setKinds(dispatcher(), { allowStaff: true, allowSeparate: false, expectedVersion: now.version });
      expect(!noOwn.ok && noOwn.message).toMatch(/account of their own/);
    });
  });

  describe('a member of staff who rides', () => {
    it('rides with the account they have, and the rider app knows them', async () => {
      const { id, userId } = await staffRider();
      expect(await c.deliveryRiders.forUser(userId)).toMatchObject({ riderId: id, companyId, kind: 'staff' });
      expect((await c.deliveryRiders.get(companyId, id))?.kindWords).toBe('Staff member');
    });

    it('is refused when staff are not set to ride, when the account is not staff, and twice', async () => {
      const customer = await person('customer');
      expect(await c.deliveryRiders.addStaff(dispatcher(), { userId: customer })).toMatchObject({ ok: false, reason: 'not_allowed' });
      const { id, userId } = await staffRider();
      expect(await c.deliveryRiders.addStaff(dispatcher(), { userId })).toMatchObject({ ok: false, reason: 'conflict' });
      await c.deliveryRiders.change(dispatcher(), id, { change: 'end', reason: 'Switching staff off' });
      await kinds(false, true);
      expect(await c.deliveryRiders.addStaff(dispatcher(), { userId: await person('super_admin') })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });

    it('stops being a rider in the app when they stop being staff or their account is switched off', async () => {
      const { userId } = await staffRider();
      await db.update(schema.users).set({ role: 'customer' }).where(eq(schema.users.id, userId));
      expect(await c.deliveryRiders.forUser(userId)).toBeNull();
      await db.update(schema.users).set({ role: 'super_admin', status: 'suspended' }).where(eq(schema.users.id, userId));
      expect(await c.deliveryRiders.forUser(userId)).toBeNull();
    });
  });

  describe('a rider with an account of their own', () => {
    it('gets an account that is not staff, must choose a password at first sign-in, and can open the rider app', async () => {
      const { id, userId, email } = await ownRider();
      const [account] = await db.select().from(schema.users).where(eq(schema.users.id, userId));
      expect(account).toMatchObject({ role: 'rider', email, mustChangePassword: true, phone: '0722000111' });
      expect(await c.deliveryRiders.forUser(userId)).toMatchObject({ riderId: id, kind: 'separate', name: 'Achieng Rider' });
    });

    it('is refused when own accounts are off, for a weak password, a missing phone, and an email already used', async () => {
      const email = `dup-${randomUUID()}@riders.test`;
      const first = await ownRider(email);
      const input = { name: 'X Rider', email: `x-${randomUUID()}@riders.test`, phone: '0722000222', password: 'a-good-password' };
      expect(await c.deliveryRiders.createSeparate(dispatcher(), { ...input, password: 'short' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryRiders.createSeparate(dispatcher(), { ...input, phone: '' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryRiders.createSeparate(dispatcher(), { ...input, email })).toMatchObject({ ok: false, reason: 'conflict' });
      await c.deliveryRiders.change(dispatcher(), first.id, { change: 'end', reason: 'Switching own accounts off' });
      await kinds(true, false);
      expect(await c.deliveryRiders.createSeparate(dispatcher(), input)).toMatchObject({ ok: false, reason: 'not_allowed' });
    });

    it('leaves no account behind when the rider cannot be saved', async () => {
      const email = `orphan-${randomUUID()}@riders.test`;
      const bad = await c.deliveryRiders.createSeparate(dispatcher(), { name: 'Y Rider', email, phone: '0722000333', password: 'a-good-password', branchId: randomUUID() });
      expect(bad).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))).toEqual([]);
    });

    it('can have the password set again by the company, and only if the account is theirs to set', async () => {
      const own = await ownRider();
      expect(await c.deliveryRiders.resetPassword(dispatcher(), own.id, 'another-good-one')).toMatchObject({ ok: true });
      const [account] = await db.select().from(schema.users).where(eq(schema.users.id, own.userId));
      expect(account?.mustChangePassword).toBe(true);
      expect(await c.deliveryRiders.resetPassword(dispatcher(), own.id, 'short')).toMatchObject({ ok: false, reason: 'bad_input' });
      const staff = await staffRider();
      expect(await c.deliveryRiders.resetPassword(dispatcher(), staff.id, 'another-good-one')).toMatchObject({ ok: false, reason: 'not_allowed' });
    });
  });

  describe('pausing, ending and resuming', () => {
    it('needs a reason to pause or end, keeps it, and the rider app lets them in only while they ride', async () => {
      const { id, userId } = await staffRider();
      expect(await c.deliveryRiders.change(dispatcher(), id, { change: 'pause' })).toMatchObject({ ok: false, reason: 'bad_input' });
      const paused = await c.deliveryRiders.change(dispatcher(), id, { change: 'pause', reason: 'On leave' });
      expect(paused.ok && paused.data).toMatchObject({ status: 'paused', statusReason: 'On leave' });
      expect(await c.deliveryRiders.forUser(userId)).toBeNull();
      const back = await c.deliveryRiders.change(dispatcher(), id, { change: 'resume' });
      expect(back.ok && back.data).toMatchObject({ status: 'active', statusReason: null });
      expect(await c.deliveryRiders.forUser(userId)).not.toBeNull();
      const ended = await c.deliveryRiders.change(dispatcher(), id, { change: 'end', reason: 'Left the company' });
      expect(ended.ok && ended.data.statusWords).toBe('Left');
      expect(await c.deliveryRiders.change(dispatcher(), id, { change: 'end', reason: 'Again' })).toMatchObject({ ok: false, reason: 'not_allowed' });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, id));
      expect(log.map((l) => l.action).sort()).toEqual(['rider.added', 'rider.end', 'rider.pause', 'rider.resume']);
    });

    it('cannot be paused or ended with a run still to do, and says how many', async () => {
      const { id } = await staffRider();
      await runFor(id, await branch());
      const refused = await c.deliveryRiders.change(dispatcher(), id, { change: 'end', reason: 'Left' });
      expect(refused).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(!refused.ok && refused.message).toMatch(/1 run to do/);
    });

    it('cannot be resumed once their kind is switched off', async () => {
      const own = await ownRider();
      await c.deliveryRiders.change(dispatcher(), own.id, { change: 'end', reason: 'Stopped' });
      await kinds(true, false);
      expect(await c.deliveryRiders.change(dispatcher(), own.id, { change: 'resume' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });

    it('refuses a stale version', async () => {
      const { id } = await staffRider();
      expect(await c.deliveryRiders.change(dispatcher(), id, { change: 'pause', reason: 'x', expectedVersion: 99 })).toMatchObject({ ok: false, reason: 'conflict' });
    });
  });

  describe('giving runs to riders', () => {
    it('keeps the rider’s name on the run as it is when the run is made, and a typed name still works', async () => {
      const rider = await staffRider();
      const branchId = await branch();
      const run = await runFor(rider.id, branchId);
      const view = await c.deliveryRuns.get(companyId, run.id);
      expect(view).toMatchObject({ riderId: rider.id });
      await c.deliveryRiders.update(dispatcher(), rider.id, { name: 'Renamed Rider' });
      expect((await c.deliveryRuns.get(companyId, run.id))?.riderName).toBe(view?.riderName);
      const typed = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderName: 'Walk-in Rider' });
      expect(typed.ok).toBe(true);
      expect(typed.ok && (await c.deliveryRuns.get(companyId, typed.data.id))?.riderId).toBeNull();
    });

    it('is refused for a rider who is paused, has left, or is of a kind switched off, and for another company’s rider id', async () => {
      const rider = await staffRider();
      const branchId = await branch();
      await c.deliveryRiders.change(dispatcher(), rider.id, { change: 'pause', reason: 'Sick' });
      expect(await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId: rider.id })).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId: randomUUID() })).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(await c.deliveryRuns.create({ companyId: randomUUID(), userId: 'x' }, { branchId, runDate: today(), riderId: rider.id })).toMatchObject({ ok: false });
    });

    it('can be given to someone else until the run goes out', async () => {
      const a = await staffRider();
      const b = await ownRider();
      const run = await runFor(a.id, await branch());
      const moved = await c.deliveryRuns.assignRider(dispatcher(), run.id, { riderId: b.id });
      expect(moved.ok && moved.data).toMatchObject({ riderId: b.id, riderName: 'Achieng Rider' });
      await db.update(schema.deliveryRuns).set({ status: 'started', startedAt: new Date() }).where(eq(schema.deliveryRuns.id, run.id));
      expect(await c.deliveryRuns.assignRider(dispatcher(), run.id, { riderId: a.id })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });
  });

  describe('a rider\'s usual vehicle', () => {
    const vehicle = async (name: string) => {
      const v = await c.deliveryVehicles.create(dispatcher(), { name: `${name} ${randomUUID().slice(0, 6)}` });
      if (!v.ok) throw new Error(v.message);
      return v.data;
    };
    const riderRow = async (id: string) => {
      const [r] = await db.select().from(schema.deliveryRiders).where(eq(schema.deliveryRiders.id, id));
      if (r === undefined) throw new Error('no rider');
      return r;
    };

    it('is chosen from the list when a rider is added, keeping its name; a stopped or unknown vehicle is refused and an account is not made for it', async () => {
      const van = await vehicle('Rider van');
      const userId = await person('super_admin');
      const made = await c.deliveryRiders.addStaff(dispatcher(), { userId, vehicleId: van.id, vehicle: 'ignored' });
      if (!made.ok) throw new Error(made.message);
      expect(await riderRow(made.data.id)).toMatchObject({ vehicleId: van.id, vehicle: van.name });
      const email = `veh-${randomUUID()}@riders.test`;
      const bad = await c.deliveryRiders.createSeparate(dispatcher(), { name: 'V Rider', email, phone: '0722000444', password: 'a-good-password', vehicleId: randomUUID() });
      expect(bad).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.email, email))).toEqual([]);
      await c.deliveryVehicles.setActive(dispatcher(), van.id, { isActive: false, expectedVersion: van.version });
      const another = await person('super_admin');
      expect(await c.deliveryRiders.addStaff(dispatcher(), { userId: another, vehicleId: van.id })).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('stopped') as string });
    });

    it('can be changed, cleared or typed in later, and is left alone by an edit that does not mention it', async () => {
      const first = await vehicle('First');
      const second = await vehicle('Second');
      const rider = await staffRider();
      const r1 = await c.deliveryRiders.update(dispatcher(), rider.id, { vehicleId: first.id, expectedVersion: 1 });
      expect(r1.ok && r1.data).toMatchObject({ vehicleId: first.id, vehicle: first.name });
      const r2 = await c.deliveryRiders.update(dispatcher(), rider.id, { phone: '0711 222 333', expectedVersion: 2 });
      expect(r2.ok && r2.data).toMatchObject({ vehicleId: first.id, vehicle: first.name });
      const r3 = await c.deliveryRiders.update(dispatcher(), rider.id, { vehicleId: second.id, expectedVersion: 3 });
      expect(r3.ok && r3.data).toMatchObject({ vehicleId: second.id, vehicle: second.name });
      const r4 = await c.deliveryRiders.update(dispatcher(), rider.id, { vehicleId: '', vehicle: 'Borrowed bike', expectedVersion: 4 });
      expect(r4.ok && r4.data).toMatchObject({ vehicleId: null, vehicle: 'Borrowed bike' });
      const r5 = await c.deliveryRiders.update(dispatcher(), rider.id, { vehicleId: '', vehicle: '', expectedVersion: 5 });
      expect(r5.ok && r5.data).toMatchObject({ vehicleId: null, vehicle: null });
    });

    it('is the vehicle of a run planned for the rider unless the office chooses or types another, and is not forced on a run when it has been stopped', async () => {
      const usual = await vehicle('Usual');
      const other = await vehicle('Other');
      const userId = await person('super_admin');
      const made = await c.deliveryRiders.addStaff(dispatcher(), { userId, vehicleId: usual.id });
      if (!made.ok) throw new Error(made.message);
      const branchId = await branch();
      const get = async (id: string) => {
        const r = await c.deliveryRuns.get(companyId, id);
        if (r === null) throw new Error('no run');
        return r;
      };
      const plain = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId: made.data.id });
      if (!plain.ok) throw new Error(plain.message);
      expect(plain.data.vehicle).toBe(usual.name);
      expect(await get(plain.data.id)).toMatchObject({ vehicleId: usual.id, vehicle: usual.name });
      const chosen = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId: made.data.id, vehicleId: other.id });
      expect(chosen.ok && (await get(chosen.data.id))).toMatchObject({ vehicleId: other.id });
      const typed = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId: made.data.id, vehicle: 'Hired lorry' });
      expect(typed.ok && (await get(typed.data.id))).toMatchObject({ vehicleId: null, vehicle: 'Hired lorry' });
      // A name typed for a rider who is only a name has no usual vehicle to bring.
      const walkIn = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderName: 'Walk-in' });
      expect(walkIn.ok && walkIn.data.vehicle).toBeNull();
      // The usual vehicle is stopped: the run is still made, with no vehicle, rather than refused.
      await c.deliveryVehicles.setActive(dispatcher(), usual.id, { isActive: false, expectedVersion: usual.version });
      const after = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId: made.data.id });
      expect(after.ok && (await get(after.data.id))).toMatchObject({ vehicleId: null, vehicle: null });
      // And it is said in words, and kept in the decision log; a run that got the vehicle, or was given one by the office, says nothing.
      expect(after.ok && after.data.vehicleNote).toMatch(/usual vehicle is stopped.*no vehicle yet/);
      expect(plain.ok && plain.data.vehicleNote).toBeNull();
      expect(chosen.ok && chosen.data.vehicleNote).toBeNull();
      const said = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, after.ok ? after.data.id : ''), eq(schema.decisionLog.action, 'run.usual_vehicle_not_used')));
      expect(said).toHaveLength(1);
    });
  });

  describe('giving a planned run to another rider', () => {
    const vehicle = async (name: string, over: Record<string, unknown> = {}) => {
      const v = await c.deliveryVehicles.create(dispatcher(), { name: `${name} ${randomUUID().slice(0, 6)}`, ...over });
      if (!v.ok) throw new Error(v.message);
      return v.data;
    };
    const riderWith = async (vehicleId?: string) => {
      const userId = await person('super_admin');
      const made = await c.deliveryRiders.addStaff(dispatcher(), { userId, ...(vehicleId === undefined ? {} : { vehicleId }) });
      if (!made.ok) throw new Error(made.message);
      return made.data.id;
    };
    const vehicleOf = async (runId: string) => {
      const r = await c.deliveryRuns.get(companyId, runId);
      if (r === null) throw new Error('no run');
      return { vehicleId: r.vehicleId, vehicle: r.vehicle };
    };

    it('brings the new rider\'s usual vehicle when the run was only following the old rider\'s, or had none', async () => {
      const bike = await vehicle('Bike');
      const van = await vehicle('Van');
      const a = await riderWith(bike.id);
      const b = await riderWith(van.id);
      const branchId = await branch();
      const run = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId: a });
      if (!run.ok) throw new Error(run.message);
      expect(await vehicleOf(run.data.id)).toEqual({ vehicleId: bike.id, vehicle: bike.name });
      expect(await c.deliveryRuns.assignRider(dispatcher(), run.data.id, { riderId: b })).toMatchObject({ ok: true, data: { vehicleId: van.id, vehicle: van.name } });
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, run.data.id), eq(schema.decisionLog.action, 'run.rider_changed')));
      expect(log.map((l) => l.reasonText)).toEqual([expect.stringContaining(`vehicle ${bike.name} to ${van.name}`) as string]);
      // A run with no vehicle at all takes the new rider's.
      const bare = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderName: 'Walk-in' });
      if (!bare.ok) throw new Error(bare.message);
      expect(await c.deliveryRuns.assignRider(dispatcher(), bare.data.id, { riderId: b })).toMatchObject({ ok: true });
      expect(await vehicleOf(bare.data.id)).toEqual({ vehicleId: van.id, vehicle: van.name });
    });

    it('leaves a vehicle the office chose or typed, a rider with no usual vehicle, and a stopped usual vehicle alone', async () => {
      const bike = await vehicle('Bike');
      const van = await vehicle('Van');
      const other = await vehicle('Chosen');
      const a = await riderWith(bike.id);
      const b = await riderWith(van.id);
      const plain = await riderWith();
      const branchId = await branch();
      const make = async (over: Record<string, unknown>) => {
        const r = await c.deliveryRuns.create(dispatcher(), { branchId, runDate: today(), riderId: a, ...over });
        if (!r.ok) throw new Error(r.message);
        return r.data.id;
      };
      const chosen = await make({ vehicleId: other.id });
      await c.deliveryRuns.assignRider(dispatcher(), chosen, { riderId: b });
      expect(await vehicleOf(chosen)).toEqual({ vehicleId: other.id, vehicle: other.name });
      const typed = await make({ vehicle: 'Hired lorry' });
      await c.deliveryRuns.assignRider(dispatcher(), typed, { riderId: b });
      expect(await vehicleOf(typed)).toEqual({ vehicleId: null, vehicle: 'Hired lorry' });
      const toPlain = await make({});
      await c.deliveryRuns.assignRider(dispatcher(), toPlain, { riderId: plain });
      expect(await vehicleOf(toPlain)).toEqual({ vehicleId: bike.id, vehicle: bike.name });
      const sameRider = await make({});
      await c.deliveryRuns.assignRider(dispatcher(), sameRider, { riderId: a });
      expect(await vehicleOf(sameRider)).toEqual({ vehicleId: bike.id, vehicle: bike.name });
      const stoppedVan = await vehicle('Old van');
      const c2 = await riderWith(stoppedVan.id);
      const following = await make({});
      await c.deliveryVehicles.setActive(dispatcher(), stoppedVan.id, { isActive: false, expectedVersion: stoppedVan.version });
      const skipped = await c.deliveryRuns.assignRider(dispatcher(), following, { riderId: c2 });
      expect(skipped).toMatchObject({ ok: true, data: { vehicleNote: expect.stringMatching(/usual vehicle is stopped.*keeps .*Bike/) as string } });
      expect(await vehicleOf(following)).toEqual({ vehicleId: bike.id, vehicle: bike.name });
      const noted = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, following), eq(schema.decisionLog.action, 'run.rider_changed')));
      expect(noted.map((l) => l.reasonText)).toEqual([expect.stringContaining('usual vehicle not used') as string]);
      // Says nothing when nothing was skipped: the office's own choice, a rider with no usual vehicle, the same rider.
      expect(await c.deliveryRuns.assignRider(dispatcher(), chosen, { riderId: a })).toMatchObject({ ok: true, data: { vehicleNote: null } });
      expect(await c.deliveryRuns.assignRider(dispatcher(), toPlain, { riderId: plain })).toMatchObject({ ok: true, data: { vehicleNote: null } });
    });

    it('keeps the vehicle when the new rider\'s usual one could not carry what is already on the run', async () => {
      const bike = await vehicle('Bike');
      const small = await vehicle('Small', { maxWeightKg: 12 });
      const a = await riderWith(bike.id);
      const b = await riderWith(small.id);
      const ready = await readyDelivery();
      await db.update(schema.products).set({ weight: '10' }).where(eq(schema.products.name, ready.productName));
      const run = await c.deliveryRuns.create(dispatcher(), { branchId: ready.branchId, runDate: today(), riderId: a });
      if (!run.ok) throw new Error(run.message);
      expect(await c.deliveryRuns.addStop(dispatcher(), run.data.id, ready.deliveryId)).toMatchObject({ ok: true });
      // 3 x 10 kg is more than the small vehicle takes: the rider changes, the vehicle stays.
      expect(await c.deliveryRuns.assignRider(dispatcher(), run.data.id, { riderId: b })).toMatchObject({ ok: true, data: { vehicleId: bike.id, vehicleNote: expect.stringMatching(/Small.*cannot take what is already on the run.*carries at most 12 kg/) as string } });
    });
  });

  describe('what the rider app shows', () => {
    it('shows a rider their own runs with the customer’s address, phone and what to carry, and no one else’s', async () => {
      const mine = await ownRider();
      const theirs = await staffRider();
      const ready = await readyDelivery();
      const run = await runFor(mine.id, ready.branchId);
      const added = await c.deliveryRuns.addStop(dispatcher(), run.id, ready.deliveryId);
      expect(added.ok).toBe(true);
      const other = await runFor(theirs.id, ready.branchId);

      const me = await c.deliveryRiders.forUser(mine.userId);
      if (me === null) throw new Error('not a rider');
      const list = await c.riderRuns.mine(me);
      expect(list.open.map((r) => r.id)).toEqual([run.id]);
      const seen = await c.riderRuns.one(me, run.id);
      expect(seen?.items).toHaveLength(1);
      expect(seen?.items[0]).toMatchObject({
        receiver: { name: 'Wanjiru Buyer', phone: '0700123456' },
        address: expect.arrayContaining(['1 Test Rd']) as string[],
        items: [{ name: ready.productName, quantity: 3 }],
        links: { call: 'tel:0700123456', chat: 'https://wa.me/254700123456' },
      });
      // Another rider's run is not theirs: it is "not found", not "forbidden", so its existence is not revealed.
      expect(await c.riderRuns.one(me, other.id)).toBeNull();
      expect(await c.riderRuns.one(me, randomUUID())).toBeNull();
    });

    it('does not show a stop that has left the run', async () => {
      const mine = await staffRider();
      const ready = await readyDelivery();
      const run = await runFor(mine.id, ready.branchId);
      await c.deliveryRuns.addStop(dispatcher(), run.id, ready.deliveryId);
      await c.deliveryRuns.removeStop(dispatcher(), run.id, ready.deliveryId);
      const me = await c.deliveryRiders.forUser(mine.userId);
      if (me === null) throw new Error('not a rider');
      expect((await c.riderRuns.one(me, run.id))?.items).toEqual([]);
    });
  });
});
