import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as TrackingActions from './tracking-actions';
import type { DeliveryMessages as MessagesType } from './messages';
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
 * What customers are told and shown, against a real database: the tracking link (one token for each order, kept sealed, found by its
 * hash, turned off or renewed with a reason), the messages queued with each delivery step and sent once, tried again and left visible
 * when they cannot be sent, and the order as its customer sees it, with nothing the page must not show.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const PIN = { latitude: -1.2921, longitude: 36.8219 };

describe.skipIf(!has(url))('customer tracking and messages (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let trackingActions: typeof TrackingActions;
  let Messages: typeof MessagesType;
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
    trackingActions = await import('./tracking-actions');
    Messages = (await import('./messages')).DeliveryMessages;
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



  const stranger = '0000000000';
  const runStaff = () => ({ companyId, userId: 'dispatcher-1' });
  /** A mail port that remembers what it was asked to send, and can be made to fail. */
  const mailbox = (failures = 0) => {
    const sent: { to: string; subject: string; html: string; text: string }[] = [];
    let left = failures;
    return {
      sent,
      port: {
        name: 'test',
        send: (m: { to: string; subject: string; html: string; text?: string }) => {
          if (left > 0) {
            left -= 1;
            return Promise.reject(new Error('The mail server is not answering.'));
          }
          sent.push({ to: m.to, subject: m.subject, html: m.html, text: m.text ?? '' });
          return Promise.resolve({ messageId: 'm', provider: 'test' });
        },
      },
    };
  };
  const sender = (port: ReturnType<typeof mailbox>['port']) => new Messages(db, port, c.companySettings, c.trackingLinks);
  const messagesOf = async (deliveryId: string) => await db.select().from(schema.deliveryMessages).where(eq(schema.deliveryMessages.deliveryId, deliveryId)).orderBy(schema.deliveryMessages.createdAt);
  const send = async (id: string) => {
    const r = await c.deliveryDocuments.dispatch(staff(), id, {});
    if (!r.ok) throw new Error(r.message);
  };
  const emailOf = async (orderId: string) => (await db.select({ e: schema.orders.customerEmail }).from(schema.orders).where(eq(schema.orders.id, orderId)))[0]?.e ?? '';

  describe('the tracking link', () => {
    it('is made once for an order, kept sealed, and found by its token; many asking at once get the same one', async () => {
      const o = await order();
      const tokens = await Promise.all([1, 2, 3, 4].map(() => c.trackingLinks.tokenFor(companyId, o.id)));
      expect(new Set(tokens).size).toBe(1);
      const token = tokens[0] ?? '';
      expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
      expect(await c.trackingLinks.resolve(token)).toEqual({ companyId, orderId: o.id });
      const [row] = await db.select().from(schema.orderTrackingLinks).where(eq(schema.orderTrackingLinks.orderId, o.id));
      expect(JSON.stringify(row)).not.toContain(token);
      expect(row?.tokenHash).not.toBe(token);
      expect(row?.views).toBe(1);
      expect(await db.select().from(schema.orderTrackingLinks).where(eq(schema.orderTrackingLinks.orderId, o.id))).toHaveLength(1);
    });

    it('turns away a token that is not ours, is the wrong size, or has the wrong characters, without asking for more than the database can say', async () => {
      const o = await order();
      await c.trackingLinks.tokenFor(companyId, o.id);
      for (const bad of ['', 'short', 'A'.repeat(33), `${'A'.repeat(31)}!`, "x' OR '1'='1".padEnd(32, 'x'), undefined, 42, null]) expect(await c.trackingLinks.resolve(bad)).toBeNull();
      expect(await c.trackingLinks.resolve('A'.repeat(32))).toBeNull();
    });

    it('can be turned off or renewed, with a reason: the old link stops working at once, and it is in the decision log', async () => {
      const o = await order();
      const old = (await c.trackingLinks.tokenFor(companyId, o.id)) ?? '';
      expect(await c.trackingLinks.replace(runStaff(), o.id, { renew: true, reason: 'no' })).toMatchObject({ ok: false });
      const renewed = await c.trackingLinks.replace(runStaff(), o.id, { renew: true, reason: 'It was sent to the wrong person' });
      expect(renewed.ok).toBe(true);
      const fresh = renewed.ok ? (renewed.token ?? '') : '';
      expect(fresh).not.toBe(old);
      expect(await c.trackingLinks.resolve(old)).toBeNull();
      expect(await c.trackingLinks.resolve(fresh)).toEqual({ companyId, orderId: o.id });
      expect(await c.trackingLinks.tokenFor(companyId, o.id)).toBe(fresh);
      const off = await c.trackingLinks.replace(runStaff(), o.id, { renew: false, reason: 'The customer asked us to stop' });
      expect(off).toMatchObject({ ok: true, token: null });
      expect(await c.trackingLinks.resolve(fresh)).toBeNull();
      expect(await c.trackingLinks.tokenFor(companyId, o.id)).toBeNull();
      expect(await c.trackingLinks.describe(companyId, o.id)).toMatchObject({ active: false });
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, o.id), inArray(schema.decisionLog.action, ['tracking.link_renewed', 'tracking.link_turned_off'])));
      expect(log.map((l) => l.action).sort()).toEqual(['tracking.link_renewed', 'tracking.link_turned_off']);
      expect(await c.trackingLinks.replace(runStaff(), randomUUID(), { renew: true, reason: 'Does not exist' })).toMatchObject({ ok: false });
    });

    it('is shown and replaced through the actions only by someone allowed', async () => {
      const o = await order();
      const seen = await trackingActions.trackingLinkAction(o.id);
      expect(seen).toMatchObject({ ok: true, data: { active: true, canManage: expect.any(Boolean) as boolean } });
      expect(seen.ok ? seen.data.url : '').toMatch(/\/track\/[A-Za-z0-9_-]{32}$/);
      requirePermission.mockImplementation((p: string) => (p === 'deliveries:read' ? Promise.resolve('reader-1') : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedError' }))));
      expect(await trackingActions.replaceTrackingLinkAction({ orderId: o.id, renew: true, reason: 'Sent to the wrong person' })).toMatchObject({ ok: false });
      expect(await trackingActions.trackingLinkAction(o.id)).toMatchObject({ ok: true, data: { canManage: false } });
      requirePermission.mockResolvedValue('dispatcher-1');
      expect(await trackingActions.replaceTrackingLinkAction({ orderId: o.id, renew: true, reason: 'Sent to the wrong person' })).toMatchObject({ ok: true, data: { renewed: true } });
    });
  });

  describe('messages to the customer', () => {
    it('are queued with the step that causes them, one for each thing that happened, with the customer’s address', async () => {
      const o = await order();
      const id = await made(o);
      await toReady(id);
      expect(await messagesOf(id)).toHaveLength(0);
      await send(id);
      const first = await messagesOf(id);
      expect(first.map((m) => [m.kind, m.status])).toEqual([['out_for_delivery', 'queued']]);
      expect(first[0]?.recipient).toBe((await emailOf(o.id)).toLowerCase());
      // Failed, sent again and delivered: a message for each, in order.
      expect((await c.deliveryDocuments.failAttempt(staff(), id, { reasonCode: 'customer_absent' })).ok).toBe(true);
      expect((await c.deliveryDocuments.reattempt(staff(), id, { note: 'Home tomorrow' })).ok).toBe(true);
      await send(id);
      expect((await c.deliveryDocuments.deliver(staff(), id, { receivedBy: 'Mama Wanjiku' })).ok).toBe(true);
      expect((await messagesOf(id)).map((m) => m.kind)).toEqual(['out_for_delivery', 'attempt_failed', 'out_for_delivery', 'delivered']);
    });

    it('say part delivered for a delivery that is not the whole order, and returned when it comes back', async () => {
      const o = await order();
      const part = await made(o, [{ productId: o.a, quantity: 2 }]);
      await toReady(part);
      await send(part);
      expect((await c.deliveryDocuments.deliver(staff(), part, { receivedBy: 'X' })).ok).toBe(true);
      expect((await messagesOf(part)).map((m) => m.kind)).toEqual(['out_for_delivery', 'part_delivered']);
      const rest = await made(o);
      await toReady(rest);
      await send(rest);
      expect((await c.deliveryDocuments.failAttempt(staff(), rest, { reasonCode: 'refused' })).ok).toBe(true);
      expect((await c.deliveryDocuments.returnToStock(staff(), rest, { reason: 'Customer refused it' })).ok).toBe(true);
      expect((await messagesOf(rest)).map((m) => m.kind)).toEqual(['out_for_delivery', 'attempt_failed', 'returned']);
    });

    it('are queued once even if the same thing is queued again, and are skipped, with why, when there is no address', async () => {
      const o = await order();
      const id = await made(o);
      await toReady(id);
      await send(id);
      const [m] = await messagesOf(id);
      await db.transaction((tx) => c.deliveryMessages.enqueueIn(tx, { companyId, orderId: o.id, deliveryId: id, kind: 'out_for_delivery', key: m?.messageKey ?? '' }));
      expect(await messagesOf(id)).toHaveLength(1);
      const nobody = await order();
      await db.update(schema.orders).set({ customerEmail: 'no-address' }).where(eq(schema.orders.id, nobody.id));
      const other = await made(nobody);
      await toReady(other);
      await send(other);
      expect((await messagesOf(other))[0]).toMatchObject({ status: 'skipped', recipient: null, lastError: expect.stringContaining('no email address') as string });
    });

    it('are sent once with the tracking link and only what the page shows: no street, no phone, no payment detail', async () => {
      const o = await order({ method: 'courier' });
      const id = await made(o);
      await toReady(id);
      expect((await c.deliveryDocuments.dispatch(staff(), id, { courierName: 'Swift Couriers', trackingNumber: 'SW123' })).ok).toBe(true);
      const box = mailbox();
      const to = (await emailOf(o.id)).toLowerCase();
      const mine = () => box.sent.filter((m) => m.to === to);
      await Promise.all([sender(box.port).flush(500), sender(box.port).flush(500)]);
      const got = mine();
      expect(got).toHaveLength(1);
      const token = (await c.trackingLinks.tokenFor(companyId, o.id)) ?? '';
      expect(got[0]?.subject).toContain(o.number);
      expect(got[0]?.html).toContain(`/track/${token}`);
      expect(got[0]?.text).toContain(`/track/${token}`);
      expect(got[0]?.text).toContain('Swift Couriers');
      expect(`${got[0]?.html ?? ''} ${got[0]?.text ?? ''}`).not.toMatch(/Test Rd|0700000000|mpesa|\b0[17]\d{8}\b/i);
      expect((await messagesOf(id))[0]).toMatchObject({ status: 'sent', attempts: 1 });
      expect((await messagesOf(id))[0]?.sentAt).not.toBeNull();
      await sender(box.port).flush(500);
      expect(mine()).toHaveLength(1);
    });

    it('are tried again later when the mail cannot be sent, never undo the step, and stay visible as not sent when it never works', async () => {
      const o = await order();
      const id = await made(o);
      await toReady(id);
      await send(id);
      const broken = mailbox(99);
      await sender(broken.port).flush(500);
      let m = (await messagesOf(id))[0];
      expect(m).toMatchObject({ status: 'failed', attempts: 1, lastError: expect.stringContaining('not answering') as string });
      expect(m?.nextTryAt.getTime()).toBeGreaterThan(Date.now());
      expect((await view(id)).status).toBe('out_for_delivery');
      // Not due yet: nothing is tried. Made due, and the mail works: it goes.
      const working = mailbox();
      await sender(working.port).flush(500);
      expect(working.sent.some((s) => s.subject.includes(o.number))).toBe(false);
      await db.update(schema.deliveryMessages).set({ nextTryAt: new Date(Date.now() - 1000) }).where(eq(schema.deliveryMessages.deliveryId, id));
      await sender(working.port).flush(500);
      m = (await messagesOf(id))[0];
      expect(m).toMatchObject({ status: 'sent', attempts: 2 });
      // After the last try it is left alone, failed, for a person to see.
      const stuck = await order();
      const stuckId = await made(stuck);
      await toReady(stuckId);
      await send(stuckId);
      await db.update(schema.deliveryMessages).set({ status: 'failed', attempts: 5, nextTryAt: new Date(Date.now() - 1000), lastError: 'Gave up' }).where(eq(schema.deliveryMessages.deliveryId, stuckId));
      await sender(working.port).flush(500);
      expect((await messagesOf(stuckId))[0]).toMatchObject({ status: 'failed', attempts: 5 });
      const listed = await c.deliveryMessages.forDelivery(companyId, stuckId);
      expect(listed[0]).toMatchObject({ status: 'failed', note: 'Gave up' });
      expect(listed[0]?.recipient).toMatch(/^.\*\*\*@/);
    });
  });

  describe('the order as its customer sees it', () => {
    it('shows each delivery in the customer’s words with what is in it, what is still to be sent, and the courier, and leaves out drafts and cancelled ones', async () => {
      const o = await order({ method: 'courier' });
      expect((await c.trackedOrders.forOrder(companyId, o.id))).toMatchObject({ kind: 'delivery', state: 'not_started', deliveries: [], waiting: [{ quantity: 5 }, { quantity: 2 }] });
      await made(o, [{ productId: o.b, quantity: 1 }]);
      const sentId = await made(o, [{ productId: o.a, quantity: 3 }]);
      await toReady(sentId);
      expect((await c.deliveryDocuments.dispatch(staff(), sentId, { courierName: 'Swift Couriers', trackingNumber: 'SW123' })).ok).toBe(true);
      const dropped = await made(o, [{ productId: o.a, quantity: 1 }]);
      expect((await c.deliveryDocuments.cancel(staff(), dropped, { reason: 'Made by mistake' })).ok).toBe(true);
      const t = await c.trackedOrders.forOrder(companyId, o.id);
      expect(t?.deliveries).toHaveLength(1);
      expect(t?.deliveries[0]).toMatchObject({ status: 'out_for_delivery', courier: { name: 'Swift Couriers', trackingNumber: 'SW123' }, items: [{ quantity: 3 }] });
      expect(t?.state).toBe('in_progress');
      // The draft the shop has not released is not shown as a delivery, so its goods are still to be sent.
      expect(t?.waiting.reduce((n, w) => n + w.quantity, 0)).toBe(2 + 2);
    });

    it('never carries an address, a phone number, a price, a rider or a stock detail', async () => {
      const o = await order();
      const id = await made(o);
      await toReady(id);
      await send(id);
      const text = JSON.stringify(await c.trackedOrders.forOrder(companyId, o.id));
      expect(text).not.toMatch(/Test Rd|0700000000|1000|dispatcher-1|KES|branch|Westlands/i);
      expect(text).not.toContain(stranger);
    });

    it('is the collection, without its code, for an order that is collected, and nothing for an order of nobody’s', async () => {
      const o = await order({ method: 'pickup' });
      const t = await c.trackedOrders.forOrder(companyId, o.id);
      expect(t).toMatchObject({ kind: 'collection', deliveries: [], collection: { status: 'waiting' } });
      const code = await c.orderCollections.codeFor(companyId, o.id);
      expect(code).not.toBeNull();
      expect(JSON.stringify(t)).not.toContain(code ?? 'no-code');
      expect(await c.trackedOrders.forOrder(companyId, randomUUID())).toBeNull();
      expect(await c.trackedOrders.forOrder(randomUUID(), o.id)).toBeNull();
    });

    it('is given to a customer who knows the order number and the address it was placed with, and to nobody else', async () => {
      const o = await order();
      const id = await made(o);
      await toReady(id);
      await send(id);
      const email = await emailOf(o.id);
      const ok = await trackingActions.trackedDeliveryAction({ orderNumber: o.number, contact: email });
      expect(ok).toMatchObject({ ok: true, data: { order: { orderNumber: o.number, kind: 'delivery' } } });
      expect(ok.ok && ok.data ? ok.data.link : '').toMatch(/\/track\/[A-Za-z0-9_-]{32}$/);
      expect(await trackingActions.trackedDeliveryAction({ orderNumber: o.number, contact: 'someone@else.test' })).toMatchObject({ ok: false });
      expect(await trackingActions.trackedDeliveryAction({ orderNumber: 'NO-SUCH-ORDER', contact: email })).toMatchObject({ ok: false });
      expect(await trackingActions.trackedDeliveryAction({ orderNumber: 5, contact: email })).toMatchObject({ ok: false });
      expect(await trackingActions.trackedDeliveryAction({ orderNumber: 'X'.repeat(80), contact: email })).toMatchObject({ ok: false });
    });
  });

  describe('the delivery note (API)', () => {
    const get = async (id: string, query = '') => {
      const { GET } = await import('../../../../app/api/admin/delivery/deliveries/[id]/note/route');
      return await GET(new Request(`http://localhost/api/admin/delivery/deliveries/${id}/note${query}`), { params: Promise.resolve({ id }) });
    };

    it('is a PDF to download or to print, for a delivery that has been released', async () => {
      const o = await order();
      const id = await made(o);
      const draft = await get(id);
      expect(draft.status).toBe(400);
      expect(((await draft.json()) as { error: string }).error).toContain('Release it');
      await toReady(id);
      const res = await get(id);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/pdf');
      expect(res.headers.get('Content-Disposition')).toMatch(/^attachment; filename="delivery-note-DLV-/);
      expect(res.headers.get('Cache-Control')).toBe('private, no-store');
      expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
      expect(Buffer.from(await res.arrayBuffer()).subarray(0, 5).toString()).toBe('%PDF-');
      expect((await get(id, '?inline=1')).headers.get('Content-Disposition')).toMatch(/^inline;/);
    });

    it('is not found for a delivery that is not there or an id that is not one, and refused to someone who may not read deliveries', async () => {
      expect((await get(randomUUID())).status).toBe(404);
      expect((await get('not-an-id')).status).toBe(404);
      expect((await get("1'; DROP TABLE deliveries; --")).status).toBe(404);
      const o = await order();
      const id = await made(o);
      await toReady(id);
      const { AccessDeniedError } = await import('@/server/domains/access-control/engine');
      requirePermission.mockRejectedValue(new AccessDeniedError('deliveries:read', { allowed: false, reason: 'no_grant' } as never));
      const denied = await get(id);
      expect(denied.status).toBe(403);
      expect(denied.headers.get('Content-Type')).not.toBe('application/pdf');
    });
  });
});
