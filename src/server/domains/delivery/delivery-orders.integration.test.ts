import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray, like } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as StagesModule from '@/server/domains/orders/stages';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import { settleFinanceBacklog } from '@/server/domains/stock/test-support';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

/**
 * Choosing the branch that delivers an order and charging the delivery, against a real database: the nearest branch that can cover
 * the order (a branch may have several stock locations), what is passed over and why, the charge from the policy that applies, and
 * the order carrying exactly that branch and charge, with its record and its place on the timeline.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

// Nairobi CBD, Thika (about 40 km), Mombasa (about 440 km): the customer is in Nairobi.
const CUSTOMER = { latitude: -1.2921, longitude: 36.8219 };
const NAIROBI = { latitude: -1.2864, longitude: 36.8172 };
const THIKA = { latitude: -1.0332, longitude: 37.0693 };
const MOMBASA = { latitude: -4.0435, longitude: 39.6682 };

describe.skipIf(!has(url))('delivery for orders (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let Stages: typeof StagesModule.OrderStages;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let companyId: string;
  let itemTypeId: string;
  let spy: { mockRestore: () => void };
  const tag = randomUUID().slice(0, 6).toUpperCase();
  let n = 0;
  const code = () => `DO${tag}${String((n += 1)).padStart(3, '0')}`;
  const madeProducts: string[] = [];
  const madeBranches: string[] = [];
  const madeLocations: string[] = [];
  const madePolicies: string[] = [];

  const branch = async (pin: { latitude: number; longitude: number } | null, methods: ('own_fleet' | 'courier')[] = ['own_fleet']) => {
    const [row] = await db.insert(schema.branches).values({ companyId, code: code(), name: `Branch ${code()}`, latitude: pin?.latitude ?? null, longitude: pin?.longitude ?? null }).returning();
    const id = row?.id ?? '';
    madeBranches.push(id);
    for (const method of methods) await db.insert(schema.deliveryMethods).values({ companyId, branchId: id, method });
    return id;
  };
  /** A stock location of a branch (or of none: company stock) holding some of a product. */
  const stock = async (branchId: string | null, productId: string, quantity: number, over: { fulfilsDelivery?: boolean } = {}) => {
    const loc = await c.stockLocations.create(companyId, { code: code(), name: 'Shelf', kind: 'store', branchId, fulfilsDelivery: over.fulfilsDelivery ?? true });
    madeLocations.push(loc.id);
    if (quantity > 0) await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId: loc.id, type: 'receipt', quantity, unitCost: 10, actor: { type: 'job' } }));
    return loc.id;
  };
  const product = async (weight: number | null = null) => {
    const id = `prod_do_${randomUUID()}`;
    madeProducts.push(id);
    await db.insert(schema.products).values({ id, sku: `DO-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `DOS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Delivered ${id.slice(-6)}`, slug: `do-${randomUUID()}`, itemTypeId, price: '100', costPrice: '10', stockQuantity: 0, weight: weight === null ? null : String(weight) });
    return id;
  };
  /** An in-force flat policy for the given branches only (so tests do not meet each other's), by fee. */
  const flatFor = async (branchIds: string[], fee: number, over: Record<string, unknown> = {}) => {
    const actions = await import('./policy-actions');
    const made = await actions.createChargePolicyDraftAction(code(), { name: 'Flat', method: 'flat', currency: 'KES', priority: 0, scopes: { branch: { op: 'in', values: branchIds } }, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee }], ...over });
    if (!made.ok) throw new Error(made.error);
    madePolicies.push(made.data.id);
    const live = await actions.activateChargePolicyAction(made.data.id, 'Set up for the test');
    if (!live.ok) throw new Error(live.error);
  };
  const plan = (lines: { productId: string; quantity: number }[], over: Record<string, unknown> = {}) =>
    c.deliveryPlans.plan(companyId, { at: new Date(), currency: 'KES', channel: 'ecommerce', method: 'own_fleet', lines, pin: CUSTOMER, weightKg: 1, orderValue: 1000, ...over });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ OrderStages: Stages } = await import('@/server/domains/orders/stages'));
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Delivery Test Co');
    itemTypeId = `it_do_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await c.stockLocations.ensureDefault(companyId);
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  });
  afterAll(async () => {
    spy.mockRestore();
    await c.stockSettings.setLedgerMode(companyId, false);
    const mine = madePolicies.length === 0 ? [] : madePolicies;
    if (mine.length > 0) {
      await db.delete(schema.chargePolicyRates).where(inArray(schema.chargePolicyRates.policyId, mine));
      await db.delete(schema.chargePolicies).where(inArray(schema.chargePolicies.id, mine));
    }
    const rest = await db.select({ id: schema.chargePolicies.id }).from(schema.chargePolicies).where(like(schema.chargePolicies.code, `DO${tag}%`));
    if (rest.length > 0) {
      await db.delete(schema.chargePolicyRates).where(inArray(schema.chargePolicyRates.policyId, rest.map((r) => r.id)));
      await db.delete(schema.chargePolicies).where(inArray(schema.chargePolicies.id, rest.map((r) => r.id)));
    }
    await settleFinanceBacklog(c.finance);
  }, 120_000);

  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('user-1');
  });
  // Each test's branches and shelves are taken out of play when it is done, so the next test (and the next run) chooses among its own.
  afterEach(async () => {
    if (madeBranches.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, madeBranches));
    if (madeLocations.length > 0) await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations));
  });

  describe('choosing the branch', () => {
    it('takes the nearest branch that has all of it, and says a nearer one lacked the stock', async () => {
      const [near, mid, far] = [await branch(NAIROBI), await branch(THIKA), await branch(MOMBASA)];
      const p = await product();
      await stock(near, p, 1);
      await stock(mid, p, 10);
      await stock(far, p, 10);
      await flatFor([near, mid, far], 300);
      const r = await plan([{ productId: p, quantity: 5 }]);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.branch.id).toBe(mid);
      expect(r.choice.reason).toBe('nearer_lacked_stock');
      expect(r.choice.passedOver).toHaveLength(1);
      expect(r.choice.chosen.km).toBeGreaterThan(30);
      // Those that cover it all come first, nearest first; the nearer branch that holds only part of it comes after them.
      expect(r.choice.ranked.map((x) => x.branchId)).toEqual([mid, far, near]);
      expect(r.quote.amount).toBe(300);
    });

    it('counts all of a branch’s stock locations, and the company’s own stock for every branch', async () => {
      const [a, b] = [await branch(NAIROBI), await branch(THIKA)];
      const p = await product();
      await stock(a, p, 3);
      await stock(a, p, 4);
      await flatFor([a, b], 100);
      const two = await plan([{ productId: p, quantity: 7 }]);
      expect(two.ok && two.branch.id).toBe(a);
      // 8 units: A has 7 in two places; the company store adds the rest for any branch.
      const q = await product();
      await stock(null, q, 20);
      const central = await plan([{ productId: q, quantity: 8 }]);
      expect(central.ok).toBe(true);
      if (central.ok) expect(central.choice.reason).not.toBe('best_cover');
    });

    it('does not count a location that may not dispatch deliveries, or one that sells to another channel only', async () => {
      const [a] = [await branch(NAIROBI)];
      const p = await product();
      await stock(a, p, 50, { fulfilsDelivery: false });
      await flatFor([a], 100);
      const r = await plan([{ productId: p, quantity: 1 }]);
      expect(r).toMatchObject({ ok: false, reason: 'no_branch' });
      expect(r.ok ? '' : r.message).toMatch(/has none of the goods/);
    });

    it('when no branch has it all, takes the one holding the most and sources the rest', async () => {
      const [a, b] = [await branch(NAIROBI), await branch(THIKA)];
      const [p1, p2] = [await product(), await product()];
      await stock(a, p1, 5);
      await stock(b, p1, 5);
      await stock(b, p2, 5);
      await flatFor([a, b], 100);
      const r = await plan([{ productId: p1, quantity: 5 }, { productId: p2, quantity: 5 }]);
      expect(r.ok && r.branch.id).toBe(b);
      expect(r.ok && r.choice.partial).toBe(false);
      // Nobody has 9 of the second: B holds the most (both lines in part), A only the first, so B delivers and the rest is sourced.
      const short = await plan([{ productId: p1, quantity: 5 }, { productId: p2, quantity: 9 }]);
      expect(short.ok && short.branch.id).toBe(b);
      expect(short.ok && short.choice).toMatchObject({ reason: 'best_cover', partial: true });
    });

    it('leaves out a branch with no pin, and one that does not offer the method, and says so', async () => {
      const [pinless, courierOnly, ok] = [await branch(null), await branch(NAIROBI, ['courier']), await branch(MOMBASA)];
      const p = await product();
      for (const b of [pinless, courierOnly, ok]) await stock(b, p, 5);
      await flatFor([pinless, courierOnly, ok], 100);
      const r = await plan([{ productId: p, quantity: 1 }]);
      expect(r.ok && r.branch.id).toBe(ok);
      const mine = new Set([pinless, courierOnly, ok]);
      expect(r.ok && r.choice.excluded.filter((e) => mine.has(e.branchId)).map((e) => e.why).sort()).toEqual(['method_not_offered', 'no_pin']);
      expect(r.ok && r.choice.reason).toBe('only_candidate');
    });

    it('is the same every time for the same facts', async () => {
      const [a, b] = [await branch(NAIROBI), await branch(THIKA)];
      const p = await product();
      await stock(a, p, 5);
      await stock(b, p, 5);
      await flatFor([a, b], 250);
      const first = await plan([{ productId: p, quantity: 2 }]);
      const second = await plan([{ productId: p, quantity: 2 }]);
      expect(second).toEqual(first);
    });

    it('asks for a pin or an address, and refuses a method it cannot yet serve', async () => {
      const p = await product();
      expect(await plan([{ productId: p, quantity: 1 }], { pin: null })).toMatchObject({ ok: false, reason: 'no_destination' });
      expect(await plan([{ productId: p, quantity: 1 }], { address: { county: '  ' }, pin: null })).toMatchObject({ ok: false, reason: 'no_destination' });
      expect(await plan([{ productId: p, quantity: 1 }], { method: 'pickup' })).toMatchObject({ ok: false, reason: 'method_not_available' });
    });

    it('with only a written address the built-in map cannot place, chooses by what is held and still charges by zone', async () => {
      const a = await branch(NAIROBI);
      const p = await product();
      await stock(a, p, 5);
      await flatFor([a], 180);
      const r = await plan([{ productId: p, quantity: 1 }], { pin: null, address: { county: 'Nairobi', town: 'Westlands' } });
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.choice.reason).toBe('position_unknown');
      expect(r.destination).toMatchObject({ positionFrom: 'none', pin: null });
      expect(r.quote.amount).toBe(180);
    });

    it('says why when no policy applies to the branch it chose', async () => {
      const a = await branch(NAIROBI);
      const p = await product();
      await stock(a, p, 5);
      const r = await plan([{ productId: p, quantity: 1 }]);
      expect(r).toMatchObject({ ok: false, reason: 'no_policy' });
      expect(r.ok ? null : r.choice?.chosen.branchId).toBe(a);
    });
  });

  describe('an order that is delivered', () => {
    const place = async (productId: string, quantity: number, delivery: Parameters<typeof createOrder>[0]['delivery'], extra: Record<string, unknown> = {}) =>
      await createOrder({
        orderNumber: `DO-${randomUUID()}`,
        customerName: 'Deliver Buyer',
        customerEmail: `do-${randomUUID()}@deliver.test`,
        customerPhone: '0700000000',
        shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
        items: [{ productId, quantity }],
        currency: 'KES',
        paymentMethod: 'mpesa_daraja',
        delivery,
        ...extra,
      });

    it('is processed by the chosen branch, charged the quoted amount, and records the choice, the working and a timeline event', async () => {
      const [near, far] = [await branch(NAIROBI), await branch(MOMBASA)];
      const p = await product(2);
      await stock(near, p, 10);
      await stock(far, p, 10);
      await flatFor([near, far], 350);
      const r = await place(p, 2, { method: 'own_fleet', pin: CUSTOMER });
      expect(r.success, r.error).toBe(true);
      const order = r.order;
      expect(order?.shippingFee).toBe(350);
      expect(order?.totalAmount).toBe((order?.subtotal ?? 0) + (order?.tax ?? 0) + 350);

      const id = order?.id ?? '';
      const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, id));
      expect(row).toMatchObject({ branchId: near, shippingFee: '350.00' });
      const rec = await c.orderDeliveries.forOrder(companyId, id);
      expect(rec).toMatchObject({ branchId: near, method: 'own_fleet', chargeAmount: '350.00', currency: 'KES' });
      expect(rec?.choice).toMatchObject({ reason: 'nearest_covers_all', chosen: { branchId: near } });
      expect(rec?.charge.steps.at(-1)).toBeDefined();
      expect(rec?.destination).toMatchObject({ positionFrom: 'pin', approximate: false });

      const events = await Stages.timeline(db, id);
      expect(events.map((e) => e.stage)).toEqual(['order_placed', 'charge_quoted', 'stock_reserved']);
      const quoted = events.find((e) => e.stage === 'charge_quoted');
      expect(quoted).toMatchObject({ outcome: 'succeeded', refType: 'delivery_quote', refId: id });
      expect(quoted?.detail).toMatchObject({ charge: 350 });
      expect(typeof (quoted?.detail as Record<string, unknown> | null | undefined)?.branch).toBe('string');
      expect(row?.currentStage).toBe('order_placed');

      // The stock was held at the chosen branch, and the decision is in the log.
      const holds = await db.select().from(schema.stockReservations).where(eq(schema.stockReservations.refId, id));
      const where = await db.select().from(schema.stockLocations).where(inArray(schema.stockLocations.id, holds.map((h) => h.locationId)));
      expect(where.map((l) => l.branchId)).toEqual([near]);
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, id));
      expect(log.map((l) => l.action)).toContain('delivery.branch_chosen');
    });

    it('cannot be told a different charge or branch by the caller', async () => {
      const a = await branch(NAIROBI);
      const p = await product();
      await stock(a, p, 10);
      await flatFor([a], 275);
      const r = await place(p, 1, { method: 'own_fleet', pin: CUSTOMER }, { branchId: randomUUID() });
      expect(r.success, r.error).toBe(true);
      expect(r.order?.shippingFee).toBe(275);
      const [row] = await db.select().from(schema.orders).where(eq(schema.orders.id, r.order?.id ?? ''));
      expect(row?.branchId).toBe(a);
    });

    it('is refused with words, and no order or hold is left, when it cannot be delivered', async () => {
      const a = await branch(NAIROBI);
      const p = await product();
      await stock(a, p, 10);
      const before = await db.select().from(schema.orders).where(like(schema.orders.orderNumber, 'DO-%'));
      const r = await place(p, 1, { method: 'own_fleet', pin: CUSTOMER });
      expect(r).toMatchObject({ success: false, code: 'delivery_unavailable' });
      expect(r.error).toMatch(/No delivery charge policy/);
      const after = await db.select().from(schema.orders).where(like(schema.orders.orderNumber, 'DO-%'));
      expect(after).toHaveLength(before.length);
      const noPin = await place(p, 1, { method: 'own_fleet' });
      expect(noPin).toMatchObject({ success: false, code: 'delivery_unavailable' });
    });

    it('an order without delivery is untouched: no record, no charge event, the same shipping as before', async () => {
      const p = await product();
      await stock(null, p, 10);
      const r = await place(p, 1, undefined);
      expect(r.success, r.error).toBe(true);
      expect(r.order?.shippingFee).toBe(0);
      expect(await c.orderDeliveries.forOrder(companyId, r.order?.id ?? '')).toBeNull();
      expect((await Stages.timeline(db, r.order?.id ?? '')).map((e) => e.stage)).not.toContain('charge_quoted');
    });

    it('keeps the recorded delivery as it was: it cannot be edited, even when the policy later changes', async () => {
      const a = await branch(NAIROBI);
      const p = await product();
      await stock(a, p, 10);
      await flatFor([a], 400);
      const r = await place(p, 1, { method: 'own_fleet', pin: CUSTOMER });
      const id = r.order?.id ?? '';
      await expect(db.update(schema.orderDeliveries).set({ chargeAmount: '1.00' }).where(eq(schema.orderDeliveries.orderId, id))).rejects.toThrow();
      await expect(db.update(schema.orderDeliveries).set({ choice: { reason: 'x' } as never }).where(eq(schema.orderDeliveries.orderId, id))).rejects.toThrow();
      await flatFor([a], 999, { priority: 5 });
      expect((await c.orderDeliveries.forOrder(companyId, id))?.chargeAmount).toBe('400.00');
      // A removed branch only loses its link.
      await db.update(schema.orderDeliveries).set({ branchId: null }).where(eq(schema.orderDeliveries.orderId, id));
      expect((await c.orderDeliveries.forOrder(companyId, id))?.branchId).toBeNull();
    });
  });
});
