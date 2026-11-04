import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { has } from '@/lib/values';
import { businessDate } from '@/server/kernel/numbering/business-date';
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

describe.skipIf(!has(url))('at the door (database)', () => {
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
  const code = () => `DR${tag}${String((n += 1)).padStart(3, '0')}`;
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
  /** A photo this person just uploaded, as the upload route leaves it: private, of the right kind, not yet used. */
  const photoBy = async (userId: string) => {
    const id = `media_${randomUUID()}`;
    await db.insert(schema.mediaAssets).values({ id, provider: 'local', visibility: 'private', purpose: 'delivery_proof', storageKey: `delivery_proof/${id}.jpg`, mime: 'image/jpeg', status: 'pending', createdBy: userId, createdByEmail: '' });
    return id;
  };
  const attemptsOf = async (deliveryId: string) => await db.select().from(schema.deliveryAttempts).where(eq(schema.deliveryAttempts.deliveryId, deliveryId));
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
    const rest = await db.select({ id: schema.chargePolicies.id }).from(schema.chargePolicies).where(like(schema.chargePolicies.code, `DR${tag}%`));
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

  describe('delivered', () => {
    it('is recorded with who received it, the delivery moves and the order is told, and the try is kept', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      const k = key();
      const r = await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: k, receivedBy: 'Mama Wanjiku', note: 'Left with the gateman', lat: -1.2921, lng: 36.8219 });
      expect(r).toMatchObject({ ok: true, data: { attemptNo: 1, status: 'delivered', replayed: false } });
      const [a] = await attemptsOf(at.deliveryId);
      expect(a).toMatchObject({ result: 'delivered', receivedBy: 'Mama Wanjiku', note: 'Left with the gateman', riderId: rider.id, latitude: -1.2921, longitude: 36.8219, clientKey: k });
      const view = await c.deliveryDocuments.get(companyId, at.deliveryId);
      expect(view).toMatchObject({ status: 'delivered', receivedBy: 'Mama Wanjiku' });
      expect(view?.attempts).toHaveLength(1);
      expect(view?.attempts[0]).toMatchObject({ attemptNo: 1, resultWords: 'Delivered', riderName: expect.any(String) as string, proofs: [] });
    });

    it('sent twice is one try: the second answers as the first and changes nothing', async () => {
      const at = await onTheRoad(await staffRider());
      const input = { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama Wanjiku' };
      const first = await c.doorWork.deliver(at.self, input);
      const again = await c.doorWork.deliver(at.self, input);
      expect(first.ok && again.ok && again.data).toMatchObject({ attemptNo: 1, status: 'delivered', replayed: true });
      expect(await attemptsOf(at.deliveryId)).toHaveLength(1);
      const events = await db.select().from(schema.deliveryEvents).where(eq(schema.deliveryEvents.deliveryId, at.deliveryId));
      expect(events.filter((e) => e.action === 'deliver')).toHaveLength(1);
    });

    it('needs someone named, a real key, and a stop that is on the rider\'s own run that has gone out', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      const base = { runId: at.runId, deliveryId: at.deliveryId, clientKey: key() };
      expect(await c.doorWork.deliver(at.self, { ...base, receivedBy: '  ' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: 'short', receivedBy: 'A' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.doorWork.deliver(at.self, { ...base, deliveryId: randomUUID(), receivedBy: 'A' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.doorWork.deliver(at.self, { ...base, runId: 'not-an-id', receivedBy: 'A' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await attemptsOf(at.deliveryId)).toHaveLength(0);
      const planned = await readyDelivery();
      const run = await runFor(rider.id, planned.branchId);
      await c.deliveryRuns.addStop(dispatcher(), run.id, planned.deliveryId);
      expect(await c.doorWork.deliver(at.self, { runId: run.id, deliveryId: planned.deliveryId, clientKey: key(), receivedBy: 'A' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });

    it('is not for another rider: their stop is simply not found, and their key cannot be used to read yours', async () => {
      const mine = await onTheRoad(await staffRider());
      const other = await selfOf((await ownRider()).userId);
      const k = key();
      expect(await c.doorWork.deliver(other, { runId: mine.runId, deliveryId: mine.deliveryId, clientKey: k, receivedBy: 'X' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.doorWork.fail(other, { runId: mine.runId, deliveryId: mine.deliveryId, clientKey: key(), reasonCode: 'refused' })).toMatchObject({ ok: false, reason: 'not_found' });
      const done = await c.doorWork.deliver(mine.self, { runId: mine.runId, deliveryId: mine.deliveryId, clientKey: k, receivedBy: 'Mama' });
      expect(done.ok).toBe(true);
      expect(await c.doorWork.deliver(other, { runId: mine.runId, deliveryId: mine.deliveryId, clientKey: k, receivedBy: 'X' })).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await attemptsOf(mine.deliveryId)).toHaveLength(1);
    });

    it('cannot be done again once it is delivered', async () => {
      const at = await onTheRoad(await staffRider());
      await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama' });
      expect(await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    });
  });

  describe('the customer\'s code', () => {
    it('is made when the delivery goes out, kept off the rider\'s screen, and must be typed to mark it delivered', async () => {
      await proofRule('code');
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      const [row] = await db.select({ code: schema.deliveries.handoverCode }).from(schema.deliveries).where(eq(schema.deliveries.id, at.deliveryId));
      expect(row?.code).toMatch(/^\d{6}$/);
      const stops = await c.riderRuns.one(at.self, at.runId);
      expect(stops?.items[0]).toMatchObject({ proof: 'code', open: true });
      expect(JSON.stringify(stops)).not.toContain(row?.code ?? 'no-code');
      const base = { runId: at.runId, deliveryId: at.deliveryId, receivedBy: 'Mama' };
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key() })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringMatching(/six-digit code/) as string });
      const wrong = await c.doorWork.deliver(at.self, { ...base, clientKey: key(), code: row?.code === '000000' ? '000001' : '000000' });
      expect(wrong).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringMatching(/4 tries left/) as string });
      const right = await c.doorWork.deliver(at.self, { ...base, clientKey: key(), code: ` ${row?.code?.slice(0, 3) ?? ''}-${row?.code?.slice(3) ?? ''} ` });
      expect(right).toMatchObject({ ok: true, data: { status: 'delivered' } });
      const a = (await c.deliveryDocuments.get(companyId, at.deliveryId))?.attempts[0];
      expect(a?.proofs.map((p) => p.kind)).toEqual(['code']);
    });

    it('cannot be guessed: after five wrong tries even the right one is refused at this door', async () => {
      await proofRule('code');
      const at = await onTheRoad(await staffRider());
      const [row] = await db.select({ code: schema.deliveries.handoverCode }).from(schema.deliveries).where(eq(schema.deliveries.id, at.deliveryId));
      const wrongCode = row?.code === '123456' ? '654321' : '123456';
      const base = { runId: at.runId, deliveryId: at.deliveryId, receivedBy: 'Mama' };
      for (let i = 0; i < 5; i += 1) expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key(), code: wrongCode })).toMatchObject({ ok: false });
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key(), code: row?.code })).toMatchObject({ ok: false, reason: 'not_allowed' });
      const [after] = await db.select({ tries: schema.deliveries.codeTries }).from(schema.deliveries).where(eq(schema.deliveries.id, at.deliveryId));
      expect(after?.tries).toBe(5);
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, at.deliveryId));
      expect(log.filter((l) => l.action === 'delivery.code_wrong')).toHaveLength(5);
      expect(await attemptsOf(at.deliveryId)).toHaveLength(0);
    });

    it('is not made when the company does not ask for it, and a delivery that went out before it was asked for takes a photo instead', async () => {
      const early = await onTheRoad(await staffRider());
      const [none] = await db.select({ code: schema.deliveries.handoverCode }).from(schema.deliveries).where(eq(schema.deliveries.id, early.deliveryId));
      expect(none?.code).toBeNull();
      await proofRule('code');
      expect((await c.riderRuns.one(early.self, early.runId))?.items[0]?.proof).toBe('photo');
      const base = { runId: early.runId, deliveryId: early.deliveryId, receivedBy: 'Mama' };
      expect(await c.doorWork.deliver(early.self, { ...base, clientKey: key() })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringMatching(/photo/) as string });
      const ok = await c.doorWork.deliver(early.self, { ...base, clientKey: key(), photoId: await photoBy(early.self.userId) });
      expect(ok.ok).toBe(true);
    });
  });

  describe('a photo', () => {
    it('is needed when the company asks for one, must be the rider\'s own and unused, and is kept with the try', async () => {
      await proofRule('photo');
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      const base = { runId: at.runId, deliveryId: at.deliveryId, receivedBy: 'Mama' };
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key() })).toMatchObject({ ok: false, reason: 'bad_input' });
      const someoneElses = await photoBy((await ownRider()).userId);
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key(), photoId: someoneElses })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringMatching(/could not be used/) as string });
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key(), photoId: 'media_nothing' })).toMatchObject({ ok: false, reason: 'bad_input' });
      const mine = await photoBy(rider.userId);
      expect(await c.doorWork.deliver(at.self, { ...base, clientKey: key(), photoId: mine })).toMatchObject({ ok: true });
      const view = await c.deliveryDocuments.get(companyId, at.deliveryId);
      const proof = view?.attempts[0]?.proofs[0];
      expect(proof?.kind).toBe('photo');
      expect(await c.deliveryDocuments.proofPhoto(companyId, proof?.id ?? '')).toBe(mine);
      expect(await c.deliveryDocuments.proofPhoto(randomUUID(), proof?.id ?? '')).toBeNull();
      const [asset] = await db.select({ status: schema.mediaAssets.status }).from(schema.mediaAssets).where(eq(schema.mediaAssets.id, mine));
      expect(asset?.status).toBe('ready');
      // The same photo cannot vouch for a second door.
      const second = await onTheRoad(rider);
      expect(await c.doorWork.deliver(second.self, { runId: second.runId, deliveryId: second.deliveryId, clientKey: key(), receivedBy: 'Mama', photoId: mine })).toMatchObject({ ok: false, reason: 'bad_input' });
    });

    it('with "code or photo" either is enough', async () => {
      await proofRule('code_or_photo');
      const rider = await staffRider();
      const withPhoto = await onTheRoad(rider);
      expect(await c.doorWork.deliver(withPhoto.self, { runId: withPhoto.runId, deliveryId: withPhoto.deliveryId, clientKey: key(), receivedBy: 'A' })).toMatchObject({ ok: false });
      expect(await c.doorWork.deliver(withPhoto.self, { runId: withPhoto.runId, deliveryId: withPhoto.deliveryId, clientKey: key(), receivedBy: 'A', photoId: await photoBy(rider.userId) })).toMatchObject({ ok: true });
      const withCode = await onTheRoad(rider);
      const [row] = await db.select({ code: schema.deliveries.handoverCode }).from(schema.deliveries).where(eq(schema.deliveries.id, withCode.deliveryId));
      expect(await c.doorWork.deliver(withCode.self, { runId: withCode.runId, deliveryId: withCode.deliveryId, clientKey: key(), receivedBy: 'A', code: row?.code })).toMatchObject({ ok: true });
    });
  });

  describe('not delivered', () => {
    it('needs a reason from the list (and words for "another reason"), and is recorded as a failed attempt with its time and reason', async () => {
      const at = await onTheRoad(await staffRider());
      const base = { runId: at.runId, deliveryId: at.deliveryId };
      expect(await c.doorWork.fail(at.self, { ...base, clientKey: key() })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.doorWork.fail(at.self, { ...base, clientKey: key(), reasonCode: 'made_up' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.doorWork.fail(at.self, { ...base, clientKey: key(), reasonCode: 'other' })).toMatchObject({ ok: false, reason: 'bad_input' });
      const r = await c.doorWork.fail(at.self, { ...base, clientKey: key(), reasonCode: 'customer_absent', note: 'Phone off' });
      expect(r).toMatchObject({ ok: true, data: { attemptNo: 1, status: 'failed_attempt' } });
      const [a] = await attemptsOf(at.deliveryId);
      expect(a).toMatchObject({ result: 'customer_absent', note: 'Phone off', receivedBy: null });
      const view = await c.deliveryDocuments.get(companyId, at.deliveryId);
      expect(view).toMatchObject({ status: 'failed_attempt', failedAttempts: 1 });
      expect(view?.attempts[0]).toMatchObject({ resultWords: 'Nobody was there' });
      const [d] = await db.select({ orderId: schema.deliveries.orderId }).from(schema.deliveries).where(eq(schema.deliveries.id, at.deliveryId));
      const stages = await db.select().from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, d?.orderId ?? ''));
      const failed = stages.find((s) => s.stage === 'delivery_attempted');
      expect(failed).toMatchObject({ outcome: 'failed', reasonCode: 'customer_absent' });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, at.deliveryId));
      expect(log.map((l) => l.action)).toContain('delivery.fail_attempt');
    });

    it('is never held up by proof, may carry a photo, and then the office can send it again and the second try is number 2', async () => {
      await proofRule('code_or_photo');
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      const photoId = await photoBy(rider.userId);
      expect(await c.doorWork.fail(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), reasonCode: 'wrong_address', photoId })).toMatchObject({ ok: true });
      expect((await c.deliveryDocuments.get(companyId, at.deliveryId))?.attempts[0]?.proofs.map((p) => p.kind)).toEqual(['photo']);
      // The rider closes the run (the stop leaves it), then the office sends the delivery out again.
      expect((await c.doorWork.finish(at.self, at.runId)).ok).toBe(true);
      const again = await c.deliveryDocuments.reattempt(dispatcher(), at.deliveryId, { note: 'Customer sent a pin' });
      expect(again.ok).toBe(true);
      // Back on a run, the same delivery is tried again and the second try is number 2.
      const branchId = (await c.deliveryDocuments.get(companyId, at.deliveryId))?.branch.id ?? '';
      const run = await runFor(rider.id, branchId);
      expect((await c.deliveryRuns.addStop(dispatcher(), run.id, at.deliveryId)).ok).toBe(true);
      expect((await c.deliveryRuns.start(dispatcher(), run.id)).ok).toBe(true);
      expect(await c.doorWork.deliver(at.self, { runId: run.id, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', photoId: await photoBy(rider.userId) })).toMatchObject({ ok: true, data: { attemptNo: 2, status: 'delivered' } });
    });
  });

  describe('the customer took only part of it', () => {
    const lineOf = async (deliveryId: string) => {
      const [l] = await db.select().from(schema.deliveryLines).where(eq(schema.deliveryLines.deliveryId, deliveryId));
      if (l === undefined) throw new Error('no line');
      return l;
    };

    it('delivers what was taken, keeps why the rest was not, and leaves the rest open on the order', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      const line = await lineOf(at.deliveryId);
      const r = await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', accepted: [{ productId: line.productId, quantity: 2, reasonCode: 'damaged' }] });
      expect(r).toMatchObject({ ok: true, data: { status: 'delivered', attemptNo: 1 } });
      expect(Number((await lineOf(at.deliveryId)).delivered)).toBe(2);
      const [a] = await attemptsOf(at.deliveryId);
      expect(a?.result).toBe('part_accepted');
      const kept = await db.select().from(schema.deliveryAttemptLines).where(eq(schema.deliveryAttemptLines.attemptId, a?.id ?? ''));
      expect(kept).toHaveLength(1);
      expect(kept[0]).toMatchObject({ reasonCode: 'damaged' });
      expect([Number(kept[0]?.carried), Number(kept[0]?.accepted)]).toEqual([3, 2]);
      const view = await c.deliveryDocuments.get(companyId, at.deliveryId);
      expect(view?.attempts[0]).toMatchObject({ resultWords: 'Delivered, the customer took only part', taken: [{ accepted: 2, carried: 3, reasonWords: 'It was damaged' }] });
      // The order is only partly delivered, and one packet is open on it again.
      const [d] = await db.select({ orderId: schema.deliveries.orderId }).from(schema.deliveries).where(eq(schema.deliveries.id, at.deliveryId));
      const order = await c.deliveryDocuments.forOrder(companyId, d?.orderId ?? '');
      expect(order?.state).toBe('partly_delivered');
      expect(order?.lines[0]).toMatchObject({ delivered: 2, open: 1 });
      const stages = await db.select().from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, d?.orderId ?? ''));
      expect(stages.map((x) => x.stage)).toContain('part_delivered');
      expect(stages.map((x) => x.stage)).not.toContain('delivered');
    });

    it('the part not taken comes back to be received, no more than it was, once', async () => {
      const at = await onTheRoad(await staffRider());
      const line = await lineOf(at.deliveryId);
      await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', accepted: [{ productId: line.productId, quantity: 1, reasonCode: 'refused' }] });
      const view = await c.deliveryDocuments.get(companyId, at.deliveryId);
      const back = view?.lines[0]?.back;
      expect(back?.could).toBe(2);
      const choice = back?.choices[0]?.id ?? 'keep';
      expect(await c.deliveryDocuments.receiveReturn(dispatcher(), at.deliveryId, { lines: [{ productId: line.productId, quantity: 3, disposition: choice }] })).toMatchObject({ ok: false, reason: 'bad_input' });
      const ok = await c.deliveryDocuments.receiveReturn(dispatcher(), at.deliveryId, { lines: [{ productId: line.productId, quantity: 2, disposition: choice }] });
      expect(ok.ok).toBe(true);
      expect(await c.deliveryDocuments.receiveReturn(dispatcher(), at.deliveryId, { lines: [{ productId: line.productId, quantity: 1, disposition: choice }] })).toMatchObject({ ok: false, reason: 'conflict' });
    });

    it('is refused without a reason, with more than was carried, with nothing taken, or with a line missing', async () => {
      const at = await onTheRoad(await staffRider());
      const line = await lineOf(at.deliveryId);
      const base = { runId: at.runId, deliveryId: at.deliveryId, receivedBy: 'Mama' };
      const p = line.productId;
      for (const accepted of [[{ productId: p, quantity: 2 }], [{ productId: p, quantity: 4, reasonCode: 'damaged' }], [{ productId: p, quantity: 0, reasonCode: 'refused' }], [], [{ productId: p, quantity: 2, reasonCode: 'other' }], [{ productId: p, quantity: 2, reasonCode: 'customer_absent' }]]) {
        const r = await c.doorWork.deliver(at.self, { ...base, clientKey: key(), accepted });
        // An empty list means everything was taken; the others are refused.
        if (accepted.length === 0) expect(r.ok).toBe(true);
        else expect(r).toMatchObject({ ok: false, reason: 'bad_input' });
        if (r.ok) break;
      }
      expect((await attemptsOf(at.deliveryId)).length).toBe(1);
    });

    it('when stock is issued on arrival, only what the customer took is issued', async () => {
      await c.stockSettings.setIssueMoment(companyId, 'delivery');
      try {
        const at = await onTheRoad(await staffRider());
        const line = await lineOf(at.deliveryId);
        expect(Number(line.issued)).toBe(0);
        expect(await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', accepted: [{ productId: line.productId, quantity: 2, reasonCode: 'refused' }] })).toMatchObject({ ok: true });
        expect(Number((await lineOf(at.deliveryId)).issued)).toBe(2);
        const back = (await c.deliveryDocuments.get(companyId, at.deliveryId))?.lines[0]?.back;
        expect(back?.could).toBe(1);
      } finally {
        await c.stockSettings.setIssueMoment(companyId, 'payment');
      }
    });

    it('a delivery taken in full is delivered in full, as before', async () => {
      const at = await onTheRoad(await staffRider());
      const line = await lineOf(at.deliveryId);
      expect(await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama', accepted: [{ productId: line.productId, quantity: 3 }] })).toMatchObject({ ok: true });
      expect((await attemptsOf(at.deliveryId))[0]?.result).toBe('delivered');
      expect(await c.deliveryDocuments.get(companyId, at.deliveryId).then((v) => v?.lines[0]?.back)).toBeNull();
    });
  });

  describe('another day', () => {
    const tomorrow = () => {
      const d = new Date(`${businessDate()}T00:00:00Z`);
      d.setUTCDate(d.getUTCDate() + 1);
      return d.toISOString().slice(0, 10);
    };
    const failed = async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      await c.doorWork.fail(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), reasonCode: 'customer_absent' });
      await c.doorWork.finish(at.self, at.runId);
      return at;
    };

    it('the office puts a failed delivery back for a chosen day, which the board shows, and a bad day is refused', async () => {
      const at = await failed();
      expect(await c.deliveryDocuments.reattempt(dispatcher(), at.deliveryId, { day: businessDate() })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryDocuments.reattempt(dispatcher(), at.deliveryId, { day: '2099-01-01' })).toMatchObject({ ok: false, reason: 'bad_input' });
      const r = await c.deliveryDocuments.reattempt(dispatcher(), at.deliveryId, { day: tomorrow(), note: 'Phone was off' });
      expect(r).toMatchObject({ ok: true, data: { status: 'ready', scheduledFor: tomorrow() } });
      const board = await c.deliveryRuns.board(companyId, {}, new Date());
      expect(board.ready.find((x) => x.deliveryId === at.deliveryId)?.scheduledFor).toBe(tomorrow());
      const events = await db.select().from(schema.deliveryEvents).where(eq(schema.deliveryEvents.deliveryId, at.deliveryId));
      const e = events.find((x) => x.action === 'reattempt');
      expect(e?.note).toContain(`Wanted on ${tomorrow()}`);
      expect(e).toMatchObject({ actorType: 'user' });
    });

    it('the customer asks through their own link: recorded as theirs, only for a failed delivery of that order', async () => {
      const at = await failed();
      const [d] = await db.select({ orderId: schema.deliveries.orderId, number: schema.deliveries.number }).from(schema.deliveries).where(eq(schema.deliveries.id, at.deliveryId));
      expect(await c.deliveryDocuments.idForOrderNumber(companyId, d?.orderId ?? '', d?.number ?? '')).toBe(at.deliveryId);
      expect(await c.deliveryDocuments.idForOrderNumber(companyId, 'ord_other', d?.number ?? '')).toBeNull();
      expect(await c.deliveryDocuments.idForOrderNumber(randomUUID(), d?.orderId ?? '', d?.number ?? '')).toBeNull();
      const r = await c.deliveryDocuments.reattempt({ companyId, userId: 'customer', kind: 'customer' }, at.deliveryId, { day: tomorrow(), note: 'Asked for by the customer on their tracking page' });
      expect(r).toMatchObject({ ok: true, data: { status: 'ready', scheduledFor: tomorrow() } });
      const events = await db.select().from(schema.deliveryEvents).where(eq(schema.deliveryEvents.deliveryId, at.deliveryId));
      expect(events.find((x) => x.action === 'reattempt')).toMatchObject({ actorType: 'customer', actorId: null });
      // Now it is ready, so asking again is refused.
      expect(await c.deliveryDocuments.reattempt({ companyId, userId: 'customer', kind: 'customer' }, at.deliveryId, { day: tomorrow() })).toMatchObject({ ok: false, reason: 'not_allowed' });
      const tracked = await c.trackedOrders.forOrder(companyId, d?.orderId ?? '');
      expect(tracked?.deliveries[0]).toMatchObject({ canReschedule: false, scheduledFor: tomorrow() });
    });

    it('is offered to the customer while a failed delivery has tries left', async () => {
      const at = await failed();
      const [d] = await db.select({ orderId: schema.deliveries.orderId }).from(schema.deliveries).where(eq(schema.deliveries.id, at.deliveryId));
      const tracked = await c.trackedOrders.forOrder(companyId, d?.orderId ?? '');
      expect(tracked?.deliveries[0]).toMatchObject({ canReschedule: true, scheduledFor: null });
    });
  });

  describe('finishing the run', () => {
    it('is refused while a stop is still to do, and closes the run when every stop is done', async () => {
      const rider = await staffRider();
      const at = await onTheRoad(rider);
      expect(await c.doorWork.finish(at.self, at.runId)).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringMatching(/still to do/) as string });
      expect((await c.riderRuns.one(at.self, at.runId))?.canFinish).toBe(false);
      await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama' });
      expect((await c.riderRuns.one(at.self, at.runId))?.canFinish).toBe(true);
      const other = await selfOf((await ownRider()).userId);
      expect(await c.doorWork.finish(other, at.runId)).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.doorWork.finish(at.self, at.runId)).toMatchObject({ ok: true, data: { delivered: 1, notDelivered: 0 } });
      expect(await c.doorWork.finish(at.self, at.runId)).toMatchObject({ ok: false, reason: 'not_allowed' });
    });

    it('counts a stop that could not be delivered, without holding the rider up', async () => {
      const at = await onTheRoad(await staffRider());
      await c.doorWork.fail(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), reasonCode: 'refused' });
      expect(await c.doorWork.finish(at.self, at.runId)).toMatchObject({ ok: true, data: { delivered: 0, notDelivered: 1 } });
    });
  });

  describe('what is kept', () => {
    it('cannot be changed or removed, even straight in the database', async () => {
      const at = await onTheRoad(await staffRider());
      await c.doorWork.deliver(at.self, { runId: at.runId, deliveryId: at.deliveryId, clientKey: key(), receivedBy: 'Mama' });
      const [a] = await attemptsOf(at.deliveryId);
      await expect(db.update(schema.deliveryAttempts).set({ result: 'refused' }).where(eq(schema.deliveryAttempts.id, a?.id ?? ''))).rejects.toThrow();
      await expect(db.delete(schema.deliveryAttempts).where(eq(schema.deliveryAttempts.id, a?.id ?? ''))).rejects.toThrow();
    });

    it('keeps the phone\'s time beside the server\'s only when it is believable', async () => {
      const rider = await staffRider();
      const a1 = await onTheRoad(rider);
      await c.doorWork.deliver(a1.self, { runId: a1.runId, deliveryId: a1.deliveryId, clientKey: key(), receivedBy: 'A', clientTime: new Date().toISOString() });
      const a2 = await onTheRoad(rider);
      await c.doorWork.deliver(a2.self, { runId: a2.runId, deliveryId: a2.deliveryId, clientKey: key(), receivedBy: 'A', clientTime: '2001-01-01T00:00:00Z' });
      expect((await attemptsOf(a1.deliveryId))[0]?.clientTime).not.toBeNull();
      expect((await attemptsOf(a2.deliveryId))[0]?.clientTime).toBeNull();
    });
  });

  describe('the proof setting', () => {
    it('is versioned, logged, and refuses a rule that does not exist', async () => {
      const now = await c.deliveryRiders.settings(companyId);
      expect(await c.deliveryRiders.setProof(dispatcher(), { proof: 'signature', expectedVersion: now.version })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryRiders.setProof(dispatcher(), { proof: 'photo', expectedVersion: now.version + 9 })).toMatchObject({ ok: false, reason: 'conflict' });
      const set = await c.deliveryRiders.setProof(dispatcher(), { proof: 'photo', expectedVersion: now.version });
      expect(set.ok && set.data.proof).toBe('photo');
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, companyId));
      expect(log.map((l) => l.action)).toContain('riders.proof_set');
    });
  });
});
