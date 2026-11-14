import { createHmac, randomUUID } from 'node:crypto';
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
 * Couriers, against a real database: connecting one (its key sealed), sending a parcel with it, booking it afterwards without ever holding up the
 * dispatch, asking about it, taking its pushed news once, and cancelling it.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const PIN = { latitude: -1.2921, longitude: 36.8219 };

import { CourierError, type CourierPort } from '@/server/adapters/courier/port';
import { CourierSync } from './courier-sync';

describe.skipIf(!has(url))('couriers (database)', () => {
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
  const code = () => `CR${tag}${String((n += 1)).padStart(3, '0')}`;
  const madeBranches: string[] = [];
  const madeLocations: string[] = [];
  const dispatcher = () => ({ companyId, userId: 'dispatcher-1' });
  let clockNow = new Date();
  const at = (minutes: number) => new Date(clockNow.getTime() + minutes * 60_000);

  /** What the courier's system does, as the test sets it up. */
  const script: { book: () => ReturnType<CourierPort['book']>; track: () => ReturnType<CourierPort['track']>; cancel: () => Promise<void>; booked: number; cancelled: string[] } = {
    book: () => Promise.resolve({ trackingNumber: 'SW1', trackingUrl: 'https://track.swift.test/SW1', labelUrl: 'https://swift.test/l/SW1.pdf' }),
    track: () => Promise.resolve(null),
    cancel: () => Promise.resolve(),
    booked: 0,
    cancelled: [],
  };
  const sync = () =>
    new CourierSync(db, c.courierAccounts, c.courierShipments, c.deliveryDocuments, () => clockNow, () => ({
      id: 'http_json',
      book: () => {
        script.booked += 1;
        return script.book();
      },
      track: () => script.track(),
      cancel: (t: string) => {
        script.cancelled.push(t);
        return script.cancel();
      },
      parseWebhook: (body: string) => {
        const j = JSON.parse(body) as { t: string; s: 'in_transit' | 'delivered' | 'exception'; id: string };
        return { trackingNumber: j.t, eventId: j.id, news: { state: j.s, note: j.s === 'exception' ? 'Nobody home' : null, at: null } };
      },
    }));

  const account = async (over: Record<string, unknown> = {}) => {
    const r = await c.courierAccounts.create(dispatcher(), { name: `Swift ${code()}`, adapter: 'http_json', baseUrl: 'https://api.swift.test', apiKey: 'plain-key-123', ...over });
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };
  const branch = async () => {
    const [b] = await db.insert(schema.branches).values({ companyId, code: code(), name: `Branch ${code()}`, latitude: PIN.latitude, longitude: PIN.longitude }).returning();
    const id = b?.id ?? '';
    madeBranches.push(id);
    return id;
  };
  /** A paid order to go by courier, with its delivery made and ready to go. */
  const readyCourier = async () => {
    const branchId = await branch();
    await db.insert(schema.deliveryMethods).values({ companyId, branchId, method: 'courier' });
    const productId = `prod_cr_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `CR-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `CRS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Parcel ${productId.slice(-6)}`, slug: `cr-${randomUUID().slice(0, 8)}`, itemTypeId, price: '1000', costPrice: '10', taxRate: '0', isTaxInclusive: false, stockQuantity: 0 });
    const loc = await c.stockLocations.create(companyId, { code: code(), name: 'Shelf', kind: 'store', branchId, fulfilsDelivery: true });
    madeLocations.push(loc.id);
    await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId: loc.id, type: 'receipt', quantity: 50, unitCost: 10, actor: { type: 'job' } }));
    const policies = await import('./policy-actions');
    const made = await policies.createChargePolicyDraftAction(code(), { name: 'Flat', method: 'flat', currency: 'KES', scopes: { branch: { op: 'in', values: [branchId] } }, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 300 }], taxRate: 0 });
    if (!made.ok) throw new Error(made.error);
    const live = await policies.activateChargePolicyAction(made.data.id, 'Set up for the test');
    if (!live.ok) throw new Error(live.error);
    const r = await createOrder({
      orderNumber: `CR-${randomUUID()}`, customerName: 'Wanjiru Buyer', customerEmail: `cr-${randomUUID()}@deliver.test`, customerPhone: '0700123456',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: 2 }], currency: 'KES', paymentMethod: 'mpesa_daraja', delivery: { method: 'courier', pin: PIN },
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
    return { deliveryId: doc.data.id, orderId: r.order.id };
  };
  const sendWith = async (acc: { id: string }, tracking?: string) => {
    const ready = await readyCourier();
    const r = await c.deliveryDocuments.dispatch(dispatcher(), ready.deliveryId, { courierAccountId: acc.id, ...(tracking === undefined ? {} : { trackingNumber: tracking }) });
    if (!r.ok) throw new Error(r.message);
    // The worker's clock starts where the dispatch happened.
    clockNow = new Date();
    return ready;
  };
  const shipmentOf = async (deliveryId: string) => (await db.select().from(schema.deliveryShipments).where(eq(schema.deliveryShipments.deliveryId, deliveryId)))[0];
  const statusOf = async (deliveryId: string) => (await db.select({ s: schema.deliveries.status }).from(schema.deliveries).where(eq(schema.deliveries.id, deliveryId)))[0]?.s;
  const eventsOf = async (shipmentId: string) => await db.select().from(schema.courierEvents).where(eq(schema.courierEvents.shipmentId, shipmentId));

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
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Couriers Test Co');
    itemTypeId = `it_cr_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await c.stockLocations.ensureDefault(companyId);
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  }, 900_000);
  afterAll(async () => {
    await releaseLedgerSwitch?.();
    spy?.mockRestore();
    await c.stockSettings.setLedgerMode(companyId, false);
    const rest = await db.select({ id: schema.chargePolicies.id }).from(schema.chargePolicies).where(like(schema.chargePolicies.code, `CR${tag}%`));
    if (rest.length > 0) {
      await db.delete(schema.chargePolicyRates).where(inArray(schema.chargePolicyRates.policyId, rest.map((r) => r.id)));
      await db.delete(schema.chargePolicies).where(inArray(schema.chargePolicies.id, rest.map((r) => r.id)));
    }
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('dispatcher-1');
    clockNow = new Date();
    script.book = () => Promise.resolve({ trackingNumber: 'SW1', trackingUrl: 'https://track.swift.test/SW1', labelUrl: 'https://swift.test/l/SW1.pdf' });
    script.track = () => Promise.resolve(null);
    script.cancel = () => Promise.resolve();
    script.booked = 0;
    script.cancelled = [];
  });
  afterEach(async () => {
    if (madeBranches.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, madeBranches));
    if (madeLocations.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations));
    // Nothing a test left owing is picked up by the next test's round of work.
    await db.update(schema.deliveryShipments).set({ syncNextAt: null }).where(eq(schema.deliveryShipments.companyId, companyId));
  });

  it('connects a courier with its key sealed, shows the secret for its news once, and checks everything it is given', async () => {
    const made = await account();
    expect(made.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
    expect(made.account).toMatchObject({ adapter: 'http_json', baseUrl: 'https://api.swift.test', hasKey: true, isActive: true, version: 1 });
    expect(made.account.webhookPath).toMatch(/^\/api\/couriers\/[0-9a-f]{48}$/);
    const listed = JSON.stringify(await c.courierAccounts.list(companyId));
    expect(listed).not.toContain('plain-key-123');
    expect(listed).not.toContain(made.webhookSecret ?? 'x');
    const [row] = await db.select().from(schema.courierAccounts).where(eq(schema.courierAccounts.id, made.account.id));
    expect(JSON.stringify(row)).not.toContain('plain-key-123');
    expect(row?.secretsSealed).not.toBeNull();
    const logged = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, made.account.id), eq(schema.decisionLog.action, 'courier.account_created')));
    expect(JSON.stringify(logged)).not.toContain('plain-key-123');
    expect(await c.courierAccounts.create(dispatcher(), { name: made.account.name.toUpperCase(), adapter: 'manual' })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await account({ baseUrl: 'http://api.swift.test' }).catch((e: unknown) => (e instanceof Error ? e.message : ''))).toContain('https');
    expect(await account({ baseUrl: 'https://127.0.0.1' }).catch((e: unknown) => (e instanceof Error ? e.message : ''))).toContain('public internet');
    expect(await account({ apiKey: '' }).catch((e: unknown) => (e instanceof Error ? e.message : ''))).toContain('key');
    expect(await account({ apiKey: 'a\r\nX-Evil: 1' }).catch((e: unknown) => (e instanceof Error ? e.message : ''))).toContain('key');
    expect(await c.courierAccounts.create(dispatcher(), { name: 'x', adapter: 'manual' })).toMatchObject({ ok: false });
    expect(await c.courierAccounts.create(dispatcher(), { name: `Hand ${code()}`, adapter: 'manual' })).toMatchObject({ ok: true, data: { webhookSecret: null, account: { hasKey: false } } });
  });

  it('changes a courier with a version, keeps the key when none is given, stops and starts it, and renews the secret', async () => {
    const { account: a } = await account();
    const changed = await c.courierAccounts.update(dispatcher(), a.id, { expectedVersion: 1, baseUrl: 'https://api2.swift.test', apiKey: '' });
    expect(changed).toMatchObject({ ok: true, data: { baseUrl: 'https://api2.swift.test', hasKey: true, version: 2 } });
    expect(await c.courierAccounts.update(dispatcher(), a.id, { expectedVersion: 1, name: 'Other' })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await c.courierAccounts.connectionFor(companyId, a.id)).toMatchObject({ key: 'plain-key-123', adapter: 'http_json' });
    await c.courierAccounts.update(dispatcher(), a.id, { expectedVersion: 2, apiKey: 'new-key-456' });
    expect(await c.courierAccounts.connectionFor(companyId, a.id)).toMatchObject({ key: 'new-key-456' });
    const before = await c.courierAccounts.connectionFor(companyId, a.id);
    const renewed = await c.courierAccounts.newWebhookSecret(dispatcher(), a.id);
    expect(renewed.ok && renewed.data.webhookSecret).toMatch(/^[0-9a-f]{48}$/);
    const after = await c.courierAccounts.connectionFor(companyId, a.id);
    expect(after?.webhookSecret).not.toBe(before?.webhookSecret);
    expect(after?.key).toBe('new-key-456');
    expect(await c.courierAccounts.setActive(dispatcher(), a.id, false)).toMatchObject({ ok: true, data: { isActive: false } });
    const ready = await readyCourier();
    expect(await c.deliveryDocuments.dispatch(dispatcher(), ready.deliveryId, { courierAccountId: a.id })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.deliveryDocuments.dispatch(dispatcher(), ready.deliveryId, { courierAccountId: randomUUID() })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.courierAccounts.connectionFor(randomUUID(), a.id)).toBeNull();
  });

  it('sends a parcel at once and books it afterwards: tracking, label and link kept, the history says so, and a second round changes nothing', async () => {
    const { account: a } = await account();
    const sent = await sendWith(a);
    const before = await shipmentOf(sent.deliveryId);
    expect(before).toMatchObject({ courierName: a.name, accountId: a.id, adapter: 'http_json', syncState: 'book_pending', trackingNumber: null });
    expect(await statusOf(sent.deliveryId)).toBe('out_for_delivery');
    expect(await sync().run()).toMatchObject({ booked: 1 });
    const booked = await shipmentOf(sent.deliveryId);
    expect(booked).toMatchObject({ trackingNumber: 'SW1', trackingUrl: 'https://track.swift.test/SW1', labelUrl: 'https://swift.test/l/SW1.pdf', syncState: 'idle', syncTries: 0, syncError: null });
    expect((await c.deliveryDocuments.get(companyId, sent.deliveryId))?.trackingNumber).toBe('SW1');
    expect(await sync().run()).toMatchObject({ booked: 0 });
    expect(script.booked).toBe(1);
    expect(await c.courierShipments.forDelivery(companyId, sent.deliveryId)).toMatchObject({ connected: true, labelUrl: 'https://swift.test/l/SW1.pdf', trackingUrl: 'https://track.swift.test/SW1', syncWords: null, canRetry: false });
  });

  it('never holds up a dispatch for a courier that is down: tries again with longer waits, then leaves it failed and visible, and a retry works', async () => {
    const { account: a } = await account();
    script.book = () => Promise.reject(new CourierError('The courier could not be reached.', true));
    const sent = await sendWith(a);
    expect(await statusOf(sent.deliveryId)).toBe('out_for_delivery');
    for (let i = 1; i <= 5; i += 1) {
      expect(await sync().run()).toMatchObject({ failed: 1 });
      const s = await shipmentOf(sent.deliveryId);
      expect(s).toMatchObject({ syncState: 'book_pending', syncTries: i, syncError: 'The courier could not be reached.' });
      expect((s?.syncNextAt?.getTime() ?? 0) - clockNow.getTime()).toBeGreaterThan(0);
      clockNow = at(60);
    }
    expect(await sync().run()).toMatchObject({ failed: 1 });
    expect(await shipmentOf(sent.deliveryId)).toMatchObject({ syncState: 'book_failed', syncTries: 6, syncNextAt: null });
    expect(await c.courierShipments.forDelivery(companyId, sent.deliveryId)).toMatchObject({ syncWords: 'The courier could not be booked', canRetry: true });
    expect(await sync().run()).toMatchObject({ booked: 0, failed: 0 });
    script.book = () => Promise.resolve({ trackingNumber: 'SW9', trackingUrl: null, labelUrl: null });
    expect(await sync().retry(dispatcher(), sent.deliveryId)).toMatchObject({ ok: true });
    expect(await sync().retry(dispatcher(), sent.deliveryId)).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(await sync().run()).toMatchObject({ booked: 1 });
    expect(await shipmentOf(sent.deliveryId)).toMatchObject({ trackingNumber: 'SW9', syncState: 'idle' });
  });

  it('does not try again at what the courier refused, and never shows the courier\'s own words', async () => {
    const { account: a } = await account();
    script.book = () => Promise.reject(new Error('422 invalid phone, Authorization: Bearer plain-key-123'));
    const sent = await sendWith(a);
    expect(await sync().run()).toMatchObject({ failed: 1 });
    const s = await shipmentOf(sent.deliveryId);
    expect(s).toMatchObject({ syncState: 'book_pending' });
    expect(s?.syncError).toBe('The courier could not be reached.');
    expect(JSON.stringify(s)).not.toContain('plain-key-123');
    script.book = () => Promise.reject(new CourierError('The courier refused the request (422).', false));
    clockNow = at(60);
    await sync().run();
    expect(await shipmentOf(sent.deliveryId)).toMatchObject({ syncState: 'book_failed', syncError: 'The courier refused the request (422).' });
  });

  it('asks about a parcel on the road, completes the delivery when the courier says delivered, keeps the proof, tells the customer, and takes the same news once', async () => {
    const { account: a } = await account();
    const sent = await sendWith(a, 'TYPED1');
    expect((await shipmentOf(sent.deliveryId))?.syncState).toBe('idle');
    clockNow = at(16);
    script.track = () => Promise.resolve({ state: 'in_transit', note: 'Left the depot', at: null });
    expect(await sync().run()).toMatchObject({ polled: 1 });
    expect((await shipmentOf(sent.deliveryId))?.lastNote).toBe('Left the depot');
    clockNow = at(40);
    await sync().run();
    expect(await eventsOf((await shipmentOf(sent.deliveryId))?.id ?? '')).toHaveLength(1);
    script.track = () => Promise.resolve({ state: 'delivered', note: null, at: new Date('2026-11-08T09:30:00Z'), receivedBy: 'Mama Wanjiku', proofUrl: 'https://swift.test/pod/1.jpg' });
    clockNow = at(80);
    await sync().run();
    const done = await shipmentOf(sent.deliveryId);
    expect(done).toMatchObject({ status: 'delivered', podUrl: 'https://swift.test/pod/1.jpg', podName: 'Mama Wanjiku' });
    expect(await statusOf(sent.deliveryId)).toBe('delivered');
    const queued = await db.select({ kind: schema.deliveryMessages.kind }).from(schema.deliveryMessages).where(eq(schema.deliveryMessages.deliveryId, sent.deliveryId));
    expect(queued.map((m) => m.kind)).toContain('delivered');
    // Delivered: it is not asked about any more.
    clockNow = at(300);
    await sync().run();
    expect((await shipmentOf(sent.deliveryId))?.syncNextAt).toBeNull();
  });

  it('turns a problem the courier reports into a failed attempt with its words, and keeps what could not be reached for another round', async () => {
    const { account: a } = await account();
    const sent = await sendWith(a, 'TYPED2');
    clockNow = at(16);
    script.track = () => Promise.resolve({ state: 'exception', note: 'Nobody home', at: null });
    await sync().run();
    expect(await statusOf(sent.deliveryId)).toBe('failed_attempt');
    expect(await shipmentOf(sent.deliveryId)).toMatchObject({ status: 'exception', lastNote: 'Nobody home' });
    const other = await sendWith(a, 'TYPED3');
    clockNow = at(60);
    script.track = () => Promise.reject(new CourierError('The courier could not be reached.', true));
    expect(await sync().run()).toMatchObject({ failed: 1 });
    const s = await shipmentOf(other.deliveryId);
    expect(s).toMatchObject({ syncState: 'idle', syncError: 'The courier could not be reached.' });
    expect((s?.syncNextAt?.getTime() ?? 0) - clockNow.getTime()).toBeGreaterThanOrEqual(30 * 60_000 - 1000);
  });

  it('cancels with the courier when the delivery is cancelled, and just closes a parcel that was never booked', async () => {
    const { account: a } = await account();
    const booked = await sendWith(a);
    await sync().run();
    const unbooked = await sendWith(a);
    await db.update(schema.deliveries).set({ status: 'cancelled', closedAt: new Date() }).where(inArray(schema.deliveries.id, [booked.deliveryId, unbooked.deliveryId]));
    expect(await sync().run()).toMatchObject({ cancelled: 1 });
    expect(script.cancelled).toEqual(['SW1']);
    expect(await shipmentOf(booked.deliveryId)).toMatchObject({ syncState: 'cancelled', syncNextAt: null });
    expect(await shipmentOf(unbooked.deliveryId)).toMatchObject({ syncState: 'cancelled', trackingNumber: null });
    expect(script.booked).toBe(1);
  });

  it('listens to a courier: a signed message moves the parcel once, a wrong signature or key does nothing, and what is not news is ignored', async () => {
    const made = await account();
    const sent = await sendWith(made.account, 'PUSH1');
    const key = made.account.webhookPath.split('/').pop() ?? '';
    const secret = made.webhookSecret ?? '';
    const sign = (body: string) => createHmac('sha256', secret).update(body).digest('hex');
    const push = (body: string, sig: string | null = sign(body), k = key) => sync().receivePush(k, body, sig);
    const first = JSON.stringify({ t: 'PUSH1', s: 'in_transit', id: 'e1' });
    expect(await push(first)).toMatchObject({ status: 200, message: 'Applied.' });
    expect(await push(first)).toMatchObject({ status: 200, message: 'Already had this news.' });
    expect(await push(first, 'f'.repeat(64))).toMatchObject({ status: 401 });
    expect(await push(first, null)).toMatchObject({ status: 401 });
    expect(await push(first, sign(first), 'a'.repeat(48))).toMatchObject({ status: 404 });
    expect(await push(first, sign(first), 'short')).toMatchObject({ status: 404 });
    const stranger = JSON.stringify({ t: 'NOBODY', s: 'delivered', id: 'e2' });
    expect(await push(stranger)).toMatchObject({ status: 202 });
    const done = JSON.stringify({ t: 'PUSH1', s: 'delivered', id: 'e3' });
    expect(await push(done)).toMatchObject({ status: 200, message: 'Applied.' });
    expect(await statusOf(sent.deliveryId)).toBe('delivered');
    // News after the end is kept but changes nothing.
    const late = JSON.stringify({ t: 'PUSH1', s: 'exception', id: 'e4' });
    expect(await push(late)).toMatchObject({ status: 200, message: 'This parcel is not with a courier now.' });
    expect(await statusOf(sent.deliveryId)).toBe('delivered');
    const s = await shipmentOf(sent.deliveryId);
    expect((await eventsOf(s?.id ?? '')).map((e) => e.dedupKey).sort()).toEqual(['e1', 'e3', 'e4']);
    // What was kept cannot be changed or removed.
    await expect(db.delete(schema.courierEvents).where(eq(schema.courierEvents.shipmentId, s?.id ?? ''))).rejects.toThrow();
    // A manual courier takes no pushed news.
    const hand = await c.courierAccounts.create(dispatcher(), { name: `Hand ${code()}`, adapter: 'manual' });
    expect(hand.ok && (await push(first, sign(first), hand.data.account.webhookPath.split('/').pop())).status).toBe(404);
  });

  it('still takes news typed in by hand for a parcel sent without a connected courier', async () => {
    const ready = await readyCourier();
    expect(await c.deliveryDocuments.dispatch(dispatcher(), ready.deliveryId, { courierName: 'Boda Sam', trackingNumber: 'B1' })).toMatchObject({ ok: true });
    expect(await shipmentOf(ready.deliveryId)).toMatchObject({ accountId: null, adapter: 'manual', syncState: 'idle', syncNextAt: null });
    expect(await c.courierShipments.news(dispatcher(), ready.deliveryId, { state: 'delivered', receivedBy: 'Mama' })).toMatchObject({ ok: true });
    expect(await sync().run()).toMatchObject({ polled: 0 });
  });

  describe('a test parcel', () => {
    const asked: string[] = [];
    const accounts = async () => {
      const { CourierAccounts } = await import('./courier-accounts');
      return new CourierAccounts(db, c.decisionLog, () => ({
        id: 'http_json',
        book: (r) => {
          asked.push(r.deliveryNumber);
          return script.book();
        },
        track: () => script.track(),
        cancel: (t: string) => {
          script.cancelled.push(t);
          return script.cancel();
        },
      }));
    };

    it('books a parcel marked as a test, takes it back at once, creates no delivery, and is written in the decision log without the key', async () => {
      const made = await account();
      const before = (await db.select({ id: schema.deliveries.id }).from(schema.deliveries).where(eq(schema.deliveries.companyId, companyId))).length;
      script.cancelled = [];
      const r = await (await accounts()).testParcel(dispatcher(), made.account.id, 'ABC123');
      expect(r).toMatchObject({ ok: true, data: { booked: true, trackingNumber: 'SW1', cancelled: true, cancelMessage: null, trackingUrl: 'https://track.swift.test/SW1' } });
      expect(asked.at(-1)).toBe('TEST-ABC123');
      expect(script.cancelled).toEqual(['SW1']);
      expect((await db.select({ id: schema.deliveries.id }).from(schema.deliveries).where(eq(schema.deliveries.companyId, companyId))).length).toBe(before);
      const log = JSON.stringify(await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, made.account.id), eq(schema.decisionLog.action, 'courier.test_parcel'))));
      expect(log).toContain('"booked":true');
      expect(log).not.toContain('plain-key-123');
    });

    it('says in words when the courier refuses or cannot be reached, and tries no cancellation', async () => {
      const made = await account();
      script.cancelled = [];
      script.book = () => Promise.reject(new CourierError('The courier refused the request (401).', false));
      expect(await (await accounts()).testParcel(dispatcher(), made.account.id)).toMatchObject({ ok: true, data: { booked: false, message: 'The courier refused the request (401).', cancelled: false, trackingNumber: null } });
      script.book = () => Promise.reject(new Error('socket hang up with secret internals'));
      const odd = await (await accounts()).testParcel(dispatcher(), made.account.id);
      expect(odd).toMatchObject({ ok: true, data: { booked: false, message: 'The courier could not be reached.' } });
      expect(script.cancelled).toEqual([]);
      script.book = () => Promise.resolve({ trackingNumber: 'SW1', trackingUrl: 'https://track.swift.test/SW1', labelUrl: 'https://swift.test/l/SW1.pdf' });
    });

    it('says so when the booking worked but could not be cancelled, so the person cancels it with the courier', async () => {
      const made = await account();
      script.cancel = () => Promise.reject(new CourierError('The courier refused the request (403).', false));
      const r = await (await accounts()).testParcel(dispatcher(), made.account.id);
      expect(r).toMatchObject({ ok: true, data: { booked: true, cancelled: false } });
      expect(r.ok && r.data.cancelMessage).toContain('Cancel it in the courier\'s own system');
      script.cancel = () => Promise.resolve();
      script.book = () => Promise.resolve({ trackingNumber: null, trackingUrl: null, labelUrl: null });
      const none = await (await accounts()).testParcel(dispatcher(), made.account.id);
      expect(none.ok && none.data.cancelMessage).toContain('gave no tracking number');
      script.book = () => Promise.resolve({ trackingNumber: 'SW1', trackingUrl: 'https://track.swift.test/SW1', labelUrl: 'https://swift.test/l/SW1.pdf' });
    });

    it('is refused for a courier typed in by hand, one that is not the company\'s, and one that is not found', async () => {
      const hand = await c.courierAccounts.create(dispatcher(), { name: `Hand ${code()}`, adapter: 'manual' });
      if (!hand.ok) throw new Error(hand.message);
      expect(await (await accounts()).testParcel(dispatcher(), hand.data.account.id)).toMatchObject({ ok: false, reason: 'not_allowed', message: 'A courier typed in by hand has no system to test.' });
      const made = await account();
      expect(await (await accounts()).testParcel({ ...dispatcher(), companyId: randomUUID() }, made.account.id)).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(await (await accounts()).testParcel(dispatcher(), randomUUID())).toMatchObject({ ok: false, reason: 'not_allowed' });
      expect(await (await accounts()).testParcel(dispatcher(), 'nope')).toMatchObject({ ok: false });
    });
  });
});
