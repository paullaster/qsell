import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import { has } from '@/lib/values';
import { COLLECTION_ATTEMPT_LIMIT, normalizeCollectionCode } from '@/lib/collection-code';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as CollectionActions from './collection-actions';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import type { OrderStages as OrderStagesType } from '@/server/domains/orders/stages';
import { holdLedgerSwitch, settleFinanceBacklog } from '@/server/domains/stock/test-support';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('next/headers', () => ({ headers: () => Promise.resolve(new Headers({ 'x-real-ip': `10.9.${String(Math.floor(Math.random() * 250))}.${String(Math.floor(Math.random() * 250))}` })) }));
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }));

/**
 * Orders the customer collects from a branch, against a real database: which branches can be chosen and how the choice is checked,
 * the order and its code made together, the code never kept in the clear, the hand-over once and only once whatever races, wrong
 * tries and locking, the ID check with its own permission, a new code, and what the customer can look up about their own order.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('collecting an order from a branch (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof CollectionActions;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let OrderStages: typeof OrderStagesType;
  let companyId: string;
  let releaseLedgerSwitch: (() => Promise<void>) | undefined;
  let itemTypeId: string;
  let spy: { mockRestore: () => void } | undefined;
  const tag = randomUUID().slice(0, 6).toUpperCase();
  let n = 0;
  const code = () => `PK${tag}${String((n += 1)).padStart(3, '0')}`;
  const madeBranches: string[] = [];
  const madeLocations: string[] = [];

  const staff = () => ({ companyId, userId: 'counter-1' });

  /** A branch with a shelf, the way a shop is set up: it may offer collection, and it holds `stock` of each product it is given. */
  const branch = async (over: { pickup?: boolean; lead?: number; products?: { id: string; stock: number }[] } = {}) => {
    const [b] = await db.insert(schema.branches).values({ companyId, code: code(), name: `Branch ${code()}`, streetAddress: '5 Moi Avenue', city: 'Nairobi', countyOrState: 'Nairobi', phone: '0711000000' }).returning();
    const id = b?.id ?? '';
    madeBranches.push(id);
    if (over.pickup !== false) await db.insert(schema.deliveryMethods).values({ companyId, branchId: id, method: 'pickup', leadTimeMinutes: over.lead ?? 30 });
    const loc = await c.stockLocations.create(companyId, { code: code(), name: 'Shelf', kind: 'store', branchId: id, fulfilsDelivery: true });
    madeLocations.push(loc.id);
    for (const p of (over.products ?? []).filter((x) => x.stock > 0)) {
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p.id, locationId: loc.id, type: 'receipt', quantity: p.stock, unitCost: 10, actor: { type: 'job' } }));
    }
    return id;
  };
  const product = async () => {
    const id = `prod_pk_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `PK-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `PKS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Collected ${id.slice(-6)}`, slug: `pk-${randomUUID()}`, itemTypeId, price: '1000', costPrice: '10', taxRate: '0', isTaxInclusive: false, stockQuantity: 0 });
    return id;
  };
  const buy = async (productId: string, pickupBranchId: string | null, over: { email?: string } = {}) => {
    const email = over.email ?? `pk-${randomUUID()}@collect.test`;
    const r = await createOrder({
      orderNumber: `PK-${randomUUID()}`, customerName: 'Collecting Buyer', customerEmail: email, customerPhone: '0700000000',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja',
      delivery: { method: 'pickup', pickupBranchId },
    });
    return { r, email };
  };
  /** A paid order waiting at a branch, and the code its customer was given. */
  const waiting = async () => {
    const p = await product();
    const b = await branch({ products: [{ id: p, stock: 5 }] });
    const { r, email } = await buy(p, b);
    if (!r.success || r.order === undefined) throw new Error(r.error);
    await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    const given = await c.orderCollections.codeFor(companyId, r.order.id);
    if (given === null) throw new Error('the order has no code');
    return { order: r.order, branchId: b, productId: p, code: given, email };
  };
  const row = async (orderId: string) => {
    const [r] = await db.select().from(schema.orderCollections).where(eq(schema.orderCollections.orderId, orderId));
    return r;
  };
  const stagesOf = async (orderId: string) => (await db.select({ stage: schema.orderStageEvents.stage, outcome: schema.orderStageEvents.outcome, reason: schema.orderStageEvents.reasonCode }).from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, orderId)).orderBy(schema.orderStageEvents.sequence));

  beforeAll(async () => {
    // Files that use the company-wide stock-by-location switch take turns, so none confuses another.
    releaseLedgerSwitch = await holdLedgerSwitch(url);
    // The code is sealed with the instance's data-encryption key, as provider credentials are.
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./collection-actions');
    ({ OrderStages } = await import('@/server/domains/orders/stages'));
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Collection Test Co');
    itemTypeId = `it_pk_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
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
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('counter-1');
  });
  afterEach(async () => {
    if (madeBranches.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, madeBranches));
    if (madeLocations.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations));
  });

  describe('which branches can be chosen', () => {
    it('lists the branches that offer collection and have all of the order, with what the shop says about each', async () => {
      const p = await product();
      const has = await branch({ products: [{ id: p, stock: 3 }], lead: 90 });
      const short = await branch({ products: [{ id: p, stock: 0 }] });
      const none = await branch({ pickup: false, products: [{ id: p, stock: 9 }] });
      const points = await c.deliveryPlans.pickupPoints(companyId, { lines: [{ productId: p, quantity: 2 }], channel: 'ecommerce' });
      const find = (id: string) => points.find((x) => x.branchId === id);
      expect(find(has)).toMatchObject({ holdsAll: true, leadTimeMinutes: 90, address: '5 Moi Avenue, Nairobi, Nairobi', phone: '0711000000' });
      expect(find(short)).toMatchObject({ holdsAll: false });
      expect(find(none)).toBeUndefined();
    });

    it('checks the pick on the server: a branch that does not offer collection, or lacks the goods, or none at all, is refused in words', async () => {
      const p = await product();
      const good = await branch({ products: [{ id: p, stock: 3 }] });
      const short = await branch({ products: [{ id: p, stock: 0 }] });
      const none = await branch({ pickup: false, products: [{ id: p, stock: 3 }] });
      const plan = (pickupBranchId: string | null | undefined) => c.deliveryPlans.plan(companyId, { at: new Date(), currency: 'KES', channel: 'ecommerce', method: 'pickup', pickupBranchId, lines: [{ productId: p, quantity: 1 }], weightKg: 1, orderValue: 1000 });
      expect(await plan(undefined)).toMatchObject({ ok: false, reason: 'no_branch', message: expect.stringContaining('Choose the branch') as string });
      expect(await plan(none)).toMatchObject({ ok: false, reason: 'method_not_available' });
      expect(await plan(short)).toMatchObject({ ok: false, reason: 'no_branch', message: expect.stringContaining('does not have everything') as string });
      expect(await plan(randomUUID())).toMatchObject({ ok: false, reason: 'method_not_available' });
      const ok = await plan(good);
      expect(ok).toMatchObject({ ok: true, branch: { id: good }, choice: { reason: 'customer_chose' }, quote: { amount: 0, split: { gross: 0, net: 0, tax: 0 }, policy: null, zone: null, route: null } });
    });
  });

  describe('the order and its code', () => {
    it('makes the order and the code together, charges nothing, and keeps the code only sealed and as a hash', async () => {
      const p = await product();
      const b = await branch({ products: [{ id: p, stock: 5 }] });
      const { r } = await buy(p, b);
      expect(r.success, r.error).toBe(true);
      const order = r.order;
      if (order === undefined) throw new Error('no order');
      expect(order.shippingFee).toBe(0);
      const [delivery] = await db.select().from(schema.orderDeliveries).where(eq(schema.orderDeliveries.orderId, order.id));
      expect(delivery).toMatchObject({ method: 'pickup', branchId: b, chargeAmount: '0.00' });
      expect(delivery?.charge.policy).toBeNull();
      const stored = await row(order.id);
      expect(stored).toMatchObject({ status: 'waiting', failedAttempts: 0, branchId: b });
      const shown = await c.orderCollections.codeFor(companyId, order.id);
      expect(shown).toMatch(/^[A-Z2-9]{6}$/);
      // Nothing at rest holds the code itself.
      expect(JSON.stringify(stored)).not.toContain(shown ?? 'x');
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, order.id));
      expect(log.map((l) => l.action)).toContain('delivery.collection_code_issued');
      expect(JSON.stringify(log)).not.toContain(shown ?? 'x');
    });

    it('refuses the order, and makes none, for a branch that cannot be collected from', async () => {
      const p = await product();
      const short = await branch({ products: [{ id: p, stock: 0 }] });
      const missing = await buy(p, null);
      const lacking = await buy(p, short);
      expect(missing.r).toMatchObject({ success: false, code: 'delivery_unavailable' });
      expect(lacking.r).toMatchObject({ success: false, code: 'delivery_unavailable' });
    });
  });

  describe('handing the order over', () => {
    it('refuses to hand over an order that has not been paid for, or that was cancelled', async () => {
      const p = await product();
      const b = await branch({ products: [{ id: p, stock: 5 }] });
      const unpaid = await buy(p, b);
      const unpaidId = unpaid.r.order?.id ?? '';
      const given = (await c.orderCollections.codeFor(companyId, unpaidId)) ?? '';
      expect(await c.orderCollections.collectWithCode(staff(), unpaidId, given)).toMatchObject({ ok: false, reason: 'not_paid' });
      expect(await c.orderCollections.markReady(staff(), unpaidId)).toMatchObject({ ok: false, reason: 'not_paid' });
      const w = await waiting();
      await OrderStages.move(db, w.order.id, 'cancelled', 'cancelled', { reasonCode: 'cancelled', message: 'test' });
      expect(await c.orderCollections.collectWithCode(staff(), w.order.id, w.code)).toMatchObject({ ok: false, reason: 'order_closed' });
    });

    describe('telling the customer it is ready', () => {
      const sentMail: { to: string; text: string }[] = [];
      const texted: { to: string; text: string }[] = [];
      const flusher = async () => {
        const { DeliveryMessages } = await import('./messages');
        return new DeliveryMessages(db, { name: 'test', send: (m: { to: string; text?: string }) => { sentMail.push({ to: m.to, text: m.text ?? '' }); return Promise.resolve({ messageId: 'x', provider: 'test' }); } }, c.companySettings, { tokenFor: () => Promise.resolve('tok9') }, {
          settings: c.deliveryTextSettings,
          sender: () => Promise.resolve({ send: (m: { to: string; text: string }) => { texted.push(m); return Promise.resolve({ providerMessageId: null }); } }),
        });
      };
      const setTexts = async (enabled: boolean) => {
        const now = await c.deliveryTextSettings.get(companyId);
        return await c.deliveryTextSettings.set({ companyId, userId: 'counter-1' }, { enabled, kinds: ['ready_for_collection'], expectedVersion: now.version });
      };
      const messagesOf = async (orderId: string) => (await db.select().from(schema.deliveryMessages).where(eq(schema.deliveryMessages.orderId, orderId))).map((m) => `${m.kind}:${m.channel}:${m.status}`).sort();
      beforeEach(() => {
        sentMail.length = 0;
        texted.length = 0;
      });
      afterAll(async () => {
        await setTexts(false);
      });

      it('queues one email when it is marked ready, however often, and no text while texting is off', async () => {
        await setTexts(false);
        const w = await waiting();
        expect(await messagesOf(w.order.id)).toEqual([]);
        await c.orderCollections.markReady(staff(), w.order.id);
        await c.orderCollections.markReady(staff(), w.order.id);
        expect(await messagesOf(w.order.id)).toEqual(['ready_for_collection:email:queued']);
        const [m] = await db.select().from(schema.deliveryMessages).where(eq(schema.deliveryMessages.orderId, w.order.id));
        expect(m?.deliveryId).toBeNull();
        expect(m?.messageKey).toBe(`${w.order.id}:ready_for_collection:0`);
      });

      it('sends the branch and the code by mail and by text, and the staff screen lists them without the code', async () => {
        await setTexts(true);
        const w = await waiting();
        await c.orderCollections.markReady(staff(), w.order.id);
        expect(await messagesOf(w.order.id)).toEqual(['ready_for_collection:email:queued', 'ready_for_collection:sms:queued']);
        await (await flusher()).flush(500);
        const shown = `${w.code.slice(0, 3)}-${w.code.slice(3)}`;
        const text = texted.find((t) => t.text.includes(shown));
        expect(text?.text).toMatch(/ready to collect at .+Show code/);
        expect(text?.text).toContain('/track/tok9');
        expect(text?.text).not.toMatch(/Test Rd|0700000000/);
        expect(sentMail.some((m) => m.text.includes(shown))).toBe(true);
        expect(await messagesOf(w.order.id)).toEqual(['ready_for_collection:email:sent', 'ready_for_collection:sms:sent']);
        const looked = await actions.collectionOfOrderAction(w.order.id);
        expect(looked).toMatchObject({ ok: true, data: { messages: [{ kind: 'ready_for_collection' }, { kind: 'ready_for_collection' }] } });
        expect(JSON.stringify(looked)).not.toContain(w.code);
        expect(JSON.stringify(looked)).not.toContain(shown);
        expect(JSON.stringify(looked)).not.toContain('0700000000');
      });

      it('does not send a ready message for an order collected before it went out', async () => {
        await setTexts(true);
        const w = await waiting();
        await c.orderCollections.markReady(staff(), w.order.id);
        expect(await c.orderCollections.collectWithCode(staff(), w.order.id, w.code)).toMatchObject({ ok: true });
        await (await flusher()).flush(500);
        expect(texted.filter((t) => t.text.includes(w.order.orderNumber))).toHaveLength(0);
        expect(await messagesOf(w.order.id)).toEqual(['ready_for_collection:email:skipped', 'ready_for_collection:sms:skipped']);
      });

      it('sends the new code when a code is reissued after the customer was told, and says the old one no longer works', async () => {
        await setTexts(true);
        const w = await waiting();
        await c.orderCollections.markReady(staff(), w.order.id);
        await (await flusher()).flush(500);
        sentMail.length = 0;
        texted.length = 0;
        const fresh = await c.orderCollections.reissue(staff(), w.order.id, 'The customer lost the code');
        if (!fresh.ok) throw new Error('not reissued');
        await c.orderCollections.reissue(staff(), w.order.id, 'Lost it again, second time');
        const keys = (await db.select().from(schema.deliveryMessages).where(eq(schema.deliveryMessages.orderId, w.order.id))).map((m) => m.messageKey).sort();
        expect(keys).toEqual([`${w.order.id}:ready_for_collection:0`, `${w.order.id}:ready_for_collection:0:sms`, `${w.order.id}:ready_for_collection:1`, `${w.order.id}:ready_for_collection:1:sms`, `${w.order.id}:ready_for_collection:2`, `${w.order.id}:ready_for_collection:2:sms`].sort());
        await (await flusher()).flush(500);
        // The first reissue's message was still waiting when the second came, so it is replaced; only the latest code is ever sent.
        expect(texted).toHaveLength(1);
        expect(texted[0]?.text).toMatch(/new collection code: [A-Z0-9]{3}-[A-Z0-9]{3}\. The old one no longer works/);
        expect(texted[0]?.text).not.toContain(`${w.code.slice(0, 3)}-${w.code.slice(3)}`);
        expect(sentMail).toHaveLength(1);
        expect(sentMail[0]?.text).toContain('no longer works');
      });

      it('reminds the customer of an order left at the counter, once at 3 days and once at 6, by mail and by text, and never twice or after it is collected', async () => {
        await setTexts(true);
        const w = await waiting();
        await c.orderCollections.markReady(staff(), w.order.id);
        await (await flusher()).flush(500);
        sentMail.length = 0;
        texted.length = 0;
        const day = 86_400_000;
        const agoBy = async (days: number) => {
          await db.update(schema.orderCollections).set({ readyAt: new Date(Date.now() - days * day - 60_000) }).where(eq(schema.orderCollections.orderId, w.order.id));
        };
        const remindersOf = async () => (await db.select().from(schema.deliveryMessages).where(and(eq(schema.deliveryMessages.orderId, w.order.id), eq(schema.deliveryMessages.kind, 'collection_reminder')))).map((m) => m.messageKey).sort();
        await agoBy(2);
        await c.orderCollections.remindUncollected();
        expect(await remindersOf()).toEqual([]);
        await agoBy(3);
        await c.orderCollections.remindUncollected();
        await c.orderCollections.remindUncollected();
        expect(await remindersOf()).toEqual([`${w.order.id}:collection_reminder:1`, `${w.order.id}:collection_reminder:1:sms`]);
        await (await flusher()).flush(500);
        const shown = `${w.code.slice(0, 3)}-${w.code.slice(3)}`;
        expect(texted.filter((t) => t.text.includes('still waiting') && t.text.includes(shown))).toHaveLength(1);
        expect(sentMail.filter((m) => m.text.includes('still waiting for you') && m.text.includes('3 days'))).toHaveLength(1);
        expect(sentMail.some((m) => m.text.includes('last reminder'))).toBe(false);
        await agoBy(6);
        await c.orderCollections.remindUncollected();
        await c.orderCollections.remindUncollected();
        expect((await remindersOf()).filter((k) => !k.endsWith(':sms'))).toEqual([`${w.order.id}:collection_reminder:1`, `${w.order.id}:collection_reminder:2`]);
        await (await flusher()).flush(500);
        expect(sentMail.some((m) => m.text.includes('last reminder'))).toBe(true);
        // Both reminders given, so the order is not looked at again.
        await agoBy(9);
        await c.orderCollections.remindUncollected();
        expect((await remindersOf()).filter((k) => !k.endsWith(':sms'))).toHaveLength(2);
        const looked = await actions.collectionOfOrderAction(w.order.id);
        expect(JSON.stringify(looked)).not.toContain(w.code);
      });

      it('does not remind about an order that is collected, not yet ready, or waiting under 3 days, and a reminder not yet sent is skipped once it is collected', async () => {
        await setTexts(false);
        const notReady = await waiting();
        const fresh = await waiting();
        await c.orderCollections.markReady(staff(), fresh.order.id);
        const done = await waiting();
        await c.orderCollections.markReady(staff(), done.order.id);
        await db.update(schema.orderCollections).set({ readyAt: new Date(Date.now() - 4 * 86_400_000) }).where(eq(schema.orderCollections.orderId, done.order.id));
        await c.orderCollections.remindUncollected();
        const queuedFor = async (id: string) => (await db.select().from(schema.deliveryMessages).where(and(eq(schema.deliveryMessages.orderId, id), eq(schema.deliveryMessages.kind, 'collection_reminder')))).length;
        expect(await queuedFor(notReady.order.id)).toBe(0);
        expect(await queuedFor(fresh.order.id)).toBe(0);
        expect(await queuedFor(done.order.id)).toBe(1);
        expect(await c.orderCollections.collectWithCode(staff(), done.order.id, done.code)).toMatchObject({ ok: true });
        await (await flusher()).flush(500);
        expect(sentMail.filter((m) => m.text.includes('still waiting for you'))).toHaveLength(0);
        expect((await db.select().from(schema.deliveryMessages).where(and(eq(schema.deliveryMessages.orderId, done.order.id), eq(schema.deliveryMessages.kind, 'collection_reminder'))))[0]?.status).toBe('skipped');
      });

      it('sends nothing extra when a code is reissued before the customer was told, and the first message then carries the new code', async () => {
        await setTexts(false);
        const w = await waiting();
        const fresh = await c.orderCollections.reissue(staff(), w.order.id, 'The customer lost the code');
        if (!fresh.ok) throw new Error('not reissued');
        expect(await messagesOf(w.order.id)).toEqual([]);
        await c.orderCollections.markReady(staff(), w.order.id);
        await (await flusher()).flush(500);
        expect(sentMail).toHaveLength(1);
        expect(sentMail[0]?.text).toContain(`${fresh.code.slice(0, 3)}-${fresh.code.slice(3)}`);
        expect(sentMail[0]?.text).not.toContain('no longer works');
      });
    });

    it('is marked ready, then handed over once to whoever shows the code, however it is typed, and the order is then delivered', async () => {
      const w = await waiting();
      const ready = await c.orderCollections.markReady(staff(), w.order.id);
      expect(ready).toMatchObject({ ok: true, view: { status: 'ready', branch: { id: w.branchId } } });
      // Marking it ready again changes nothing.
      expect(await c.orderCollections.markReady(staff(), w.order.id)).toMatchObject({ ok: true, view: { status: 'ready' } });
      const typed = `${w.code.slice(0, 3).toLowerCase()} - ${w.code.slice(3).toLowerCase()}`;
      const done = await c.orderCollections.collectWithCode(staff(), w.order.id, typed);
      expect(done).toMatchObject({ ok: true, view: { status: 'collected', collectedHow: 'code' } });
      const stored = await row(w.order.id);
      expect(stored).toMatchObject({ status: 'collected', collectedBy: 'counter-1', collectedHow: 'code' });
      const [order] = await db.select({ status: schema.orders.status, deliveredAt: schema.orders.deliveredAt }).from(schema.orders).where(eq(schema.orders.id, w.order.id));
      expect(order?.status).toBe('delivered');
      expect(order?.deliveredAt).toBeInstanceOf(Date);
      const stages = (await stagesOf(w.order.id)).map((s) => `${s.stage}:${s.outcome}`);
      expect(stages).toEqual(expect.arrayContaining(['ready:succeeded', 'collected:succeeded']));
      // It works once.
      expect(await c.orderCollections.collectWithCode(staff(), w.order.id, w.code)).toMatchObject({ ok: false, reason: 'already_collected' });
      expect(await c.orderCollections.codeFor(companyId, w.order.id)).toBeNull();
    });

    it('hands the order over once even when two people at two counters type the right code at the same moment', async () => {
      const w = await waiting();
      const results = await Promise.all([c.orderCollections.collectWithCode(staff(), w.order.id, w.code), c.orderCollections.collectWithCode({ ...staff(), userId: 'counter-2' }, w.order.id, w.code)]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toMatchObject([{ reason: 'already_collected' }]);
      const handed = (await stagesOf(w.order.id)).filter((s) => s.stage === 'collected');
      expect(handed).toHaveLength(1);
    });

    it('counts a wrong code, says how many tries are left, records each as a failed attempt with its reason, and locks after the limit', async () => {
      const w = await waiting();
      const wrong = w.code === 'ABCDEF' ? 'BCDEFG' : 'ABCDEF';
      for (let tried = 1; tried < COLLECTION_ATTEMPT_LIMIT; tried += 1) {
        const left = COLLECTION_ATTEMPT_LIMIT - tried;
        expect(await c.orderCollections.collectWithCode(staff(), w.order.id, wrong)).toMatchObject({ ok: false, reason: 'wrong_code', attemptsLeft: left });
      }
      expect(await c.orderCollections.collectWithCode(staff(), w.order.id, wrong)).toMatchObject({ ok: false, reason: 'locked', attemptsLeft: 0 });
      expect(await row(w.order.id)).toMatchObject({ status: 'locked', failedAttempts: COLLECTION_ATTEMPT_LIMIT });
      const failed = (await stagesOf(w.order.id)).filter((s) => s.stage === 'delivery_attempted' && s.outcome === 'failed');
      expect(failed).toHaveLength(COLLECTION_ATTEMPT_LIMIT);
      expect(failed.map((f) => f.reason)).toEqual([...Array.from({ length: COLLECTION_ATTEMPT_LIMIT - 1 }, () => 'wrong_code'), 'code_locked']);
      // Locked: even the right code is refused until a new one is given.
      expect(await c.orderCollections.collectWithCode(staff(), w.order.id, w.code)).toMatchObject({ ok: false, reason: 'locked' });
    });

    it('treats what is not a code as a wrong try without needing the order’s code, and refuses non-text', async () => {
      const w = await waiting();
      expect(await c.orderCollections.collectWithCode(staff(), w.order.id, '!!')).toMatchObject({ ok: false, reason: 'wrong_code' });
      expect(await c.orderCollections.collectWithCode(staff(), w.order.id, 12345)).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.orderCollections.collectWithCode(staff(), w.order.id, 'x'.repeat(100))).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.orderCollections.collectWithCode(staff(), randomUUID(), w.code)).toMatchObject({ ok: false, reason: 'not_found' });
    });

    it('gives a new code on request, with a reason: the old one stops working, the tries start again, and a locked order is open again', async () => {
      const w = await waiting();
      const wrong = w.code === 'ABCDEF' ? 'BCDEFG' : 'ABCDEF';
      for (let tried = 0; tried < COLLECTION_ATTEMPT_LIMIT; tried += 1) await c.orderCollections.collectWithCode(staff(), w.order.id, wrong);
      expect(await c.orderCollections.reissue(staff(), w.order.id, 'no')).toMatchObject({ ok: false, reason: 'bad_input' });
      const fresh = await c.orderCollections.reissue(staff(), w.order.id, 'The customer lost the code');
      expect(fresh.ok).toBe(true);
      if (!fresh.ok) return;
      expect(fresh.view.status).toBe('waiting');
      expect(fresh.view.attemptsLeft).toBe(COLLECTION_ATTEMPT_LIMIT);
      if (fresh.code !== w.code) expect(await c.orderCollections.collectWithCode(staff(), w.order.id, w.code)).toMatchObject({ ok: false, reason: 'wrong_code' });
      expect(await c.orderCollections.collectWithCode(staff(), w.order.id, fresh.code)).toMatchObject({ ok: true, view: { status: 'collected' } });
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, w.order.id), eq(schema.decisionLog.action, 'delivery.collection_code_reissued')));
      expect(log).toHaveLength(1);
      expect(log[0]?.reasonText).toBe('The customer lost the code');
      expect(await c.orderCollections.reissue(staff(), w.order.id, 'Already collected, one more')).toMatchObject({ ok: false, reason: 'already_collected' });
    });

    it('hands over after an ID check only with what was seen and why, keeps both, and also works on a locked code', async () => {
      const w = await waiting();
      const wrong = w.code === 'ABCDEF' ? 'BCDEFG' : 'ABCDEF';
      for (let tried = 0; tried < COLLECTION_ATTEMPT_LIMIT; tried += 1) await c.orderCollections.collectWithCode(staff(), w.order.id, wrong);
      expect(await c.orderCollections.collectWithIdCheck(staff(), w.order.id, { idSeen: 'id', reason: 'Lost the phone with the code' })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.orderCollections.collectWithIdCheck(staff(), w.order.id, { idSeen: 'National ID ending 4321', reason: 'no' })).toMatchObject({ ok: false, reason: 'bad_input' });
      const done = await c.orderCollections.collectWithIdCheck(staff(), w.order.id, { idSeen: 'National ID ending 4321', reason: 'Lost the phone with the code' });
      expect(done).toMatchObject({ ok: true, view: { status: 'collected', collectedHow: 'id_check' } });
      expect(await row(w.order.id)).toMatchObject({ collectedHow: 'id_check', idSeen: 'National ID ending 4321' });
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, w.order.id), eq(schema.decisionLog.action, 'delivery.collected')));
      expect(log[0]).toMatchObject({ reasonText: 'Lost the phone with the code' });
      expect(await c.orderCollections.collectWithIdCheck(staff(), w.order.id, { idSeen: 'National ID ending 4321', reason: 'Again, by mistake' })).toMatchObject({ ok: false, reason: 'already_collected' });
    });

    it('keeps one company’s orders out of reach of another', async () => {
      const w = await waiting();
      const stranger = { companyId: randomUUID(), userId: 'counter-9' };
      expect(await c.orderCollections.collectWithCode(stranger, w.order.id, w.code)).toMatchObject({ ok: false, reason: 'not_found' });
      expect(await c.orderCollections.view(stranger.companyId, w.order.id)).toBeNull();
      expect(await c.orderCollections.codeFor(stranger.companyId, w.order.id)).toBeNull();
    });

    it('is enforced by the database too: a collected order without who, when and how, or an ID hand-over without the ID, cannot be stored', async () => {
      const w = await waiting();
      await expect(db.update(schema.orderCollections).set({ status: 'collected' }).where(eq(schema.orderCollections.orderId, w.order.id))).rejects.toThrow();
      await expect(db.update(schema.orderCollections).set({ status: 'collected', collectedAt: new Date(), collectedBy: 'x', collectedHow: 'id_check' }).where(eq(schema.orderCollections.orderId, w.order.id))).rejects.toThrow();
      await expect(db.update(schema.orderCollections).set({ status: 'nonsense' as never }).where(eq(schema.orderCollections.orderId, w.order.id))).rejects.toThrow();
    });
  });

  describe('the actions, behind their permissions', () => {
    it('hand an order over for a person with the handover permission, and refuse the ID check and a new code without the override permission', async () => {
      const w = await waiting();
      requirePermission.mockImplementation((permission: string) => (permission === 'deliveries:handover' ? Promise.resolve('counter-1') : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedError' }))));
      const idCheck = await actions.collectOrderAfterIdCheckAction({ orderId: w.order.id, idSeen: 'National ID ending 4321', reason: 'Lost the phone' });
      expect(idCheck.ok).toBe(false);
      const reissue = await actions.reissueCollectionCodeAction({ orderId: w.order.id, reason: 'The customer lost the code' });
      expect(reissue.ok).toBe(false);
      expect((await row(w.order.id))?.status).toBe('waiting');
      expect(await actions.markReadyForCollectionAction(w.order.id)).toMatchObject({ ok: true, data: { status: 'ready' } });
      expect(await actions.collectOrderWithCodeAction({ orderId: w.order.id, code: w.code })).toMatchObject({ ok: true, data: { status: 'collected' } });
    });

    it('say what went wrong in words as data, and never reveal the code to staff who only look', async () => {
      const w = await waiting();
      const wrong = await actions.collectOrderWithCodeAction({ orderId: w.order.id, code: w.code === 'ABCDEF' ? 'BCDEFG' : 'ABCDEF' });
      expect(wrong).toMatchObject({ ok: false, error: expect.stringContaining('not the code') as string });
      const looked = await actions.collectionOfOrderAction(w.order.id);
      expect(looked.ok).toBe(true);
      expect(JSON.stringify(looked)).not.toContain(w.code);
      expect(JSON.stringify(looked)).not.toContain(normalizeCollectionCode(w.code).toLowerCase());
    });

    it('show the customer their own code, only for the right order number and contact, and not once it is collected', async () => {
      const w = await waiting();
      const mine = await actions.trackedCollectionAction({ orderNumber: w.order.orderNumber, contact: w.email });
      expect(mine).toMatchObject({ ok: true, data: { view: { status: 'waiting', orderNumber: w.order.orderNumber } } });
      if (mine.ok && mine.data !== null) expect(normalizeCollectionCode(mine.data.code ?? '')).toBe(w.code);
      expect(await actions.trackedCollectionAction({ orderNumber: w.order.orderNumber, contact: 'someone-else@collect.test' })).toMatchObject({ ok: false });
      expect(await actions.trackedCollectionAction({ orderNumber: 'NO-SUCH-ORDER', contact: w.email })).toMatchObject({ ok: false });
      expect(await actions.trackedCollectionAction({ orderNumber: 5, contact: w.email })).toMatchObject({ ok: false });
      await c.orderCollections.collectWithCode(staff(), w.order.id, w.code);
      const after = await actions.trackedCollectionAction({ orderNumber: w.order.orderNumber, contact: w.email });
      expect(after).toMatchObject({ ok: true, data: { view: { status: 'collected' }, code: null } });
    });
  });
});
