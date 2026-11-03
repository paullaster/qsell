import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as DocumentActions from './document-actions';
import type { InventoryReservationService as ReservationType } from '@/server/domains/inventory/reservation-service';
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
 * Applying the shop's choice of when stock leaves to orders paid before it was made, against a real database: the stock of goods that
 * have not left is counted back and held for the order's deliveries, goods already sent stay issued, collected orders and a shop that
 * issues at payment are left alone, and a second run finds nothing to do.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const PIN = { latitude: -1.2921, longitude: 36.8219 };

describe.skipIf(!has(url))('orders paid before the stock timing was chosen (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let actions: typeof DocumentActions;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let OrderStages: typeof OrderStagesType;
  let fulfilOrder: (typeof ReservationType)['fulfilOrder'];
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
  const goOut = async (id: string) => {
    const r = await c.deliveryDocuments.dispatch(staff(), id, {});
    if (!r.ok) throw new Error(r.message);
  };

  beforeAll(async () => {
    // Files that switch stock-by-location for the whole company take turns, so none confuses another.
    releaseLedgerSwitch = await holdLedgerSwitch(url);
    // An order that is collected has a code, sealed with the instance's data-encryption key.
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    actions = await import('./document-actions');
    ({ OrderStages } = await import('@/server/domains/orders/stages'));
    fulfilOrder = (await import('@/server/domains/inventory/reservation-service')).InventoryReservationService.fulfilOrder.bind((await import('@/server/domains/inventory/reservation-service')).InventoryReservationService);
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


  const onHand = async (productId: string) => Number((await db.select({ t: sql<string>`COALESCE(sum(${schema.stockBalances.onHand}), 0)` }).from(schema.stockBalances).where(eq(schema.stockBalances.productId, productId)))[0]?.t ?? 0);
  const holdsOf = async (orderId: string, productId: string) => await db.select().from(schema.stockReservations).where(and(eq(schema.stockReservations.refId, orderId), eq(schema.stockReservations.productId, productId)));
  const on = (moment: 'payment' | 'dispatch' | 'delivery') => c.stockSettings.setIssueMoment(companyId, moment);
  const runTo = async (id: string, picked?: { productId: string; quantity: number }[]) => {
    await toReady(id, picked);
    await goOut(id);
  };
  const arrive = async (id: string) => {
    const r = await c.deliveryDocuments.deliver(staff(), id, { receivedBy: 'Mama Wanjiku' });
    if (!r.ok) throw new Error(r.message);
  };

  const applyAll = async () => {
    let total = { orders: 0, quantity: 0 };
    const skipped: string[] = [];
    for (let pass = 0; pass < 20; pass += 1) {
      const r = await c.stockReissue.apply({ companyId, userId: 'dispatcher-1' }, (await c.stockSettings.get()).issueMoment, skipped);
      total = { orders: total.orders + r.orders, quantity: total.quantity + r.quantity };
      skipped.push(...r.skipped.map((k) => k.orderId));
      if (r.remaining === 0) break;
    }
    return total;
  };
  const heldFor = async (orderId: string, productId: string) => (await holdsOf(orderId, productId)).filter((h) => h.state === 'held').reduce((n, h) => n + h.quantity, 0);

  describe('applying the choice to orders already paid', () => {
    it('counts the stock back and holds it for the order, so its deliveries issue it from then on; a second run finds nothing to do', async () => {
      const o = await order();
      await fulfilOrder(o.id);
      expect(await onHand(o.a)).toBe(45);
      await on('dispatch');
      const seen = await c.stockReissue.preview(companyId, 'dispatch');
      expect(seen.orders).toBeGreaterThanOrEqual(1);
      expect(seen.quantity).toBeGreaterThanOrEqual(7);

      await applyAll();
      expect(await onHand(o.a)).toBe(50);
      expect(await onHand(o.b)).toBe(50);
      expect(await heldFor(o.id, o.a)).toBe(5);
      const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, o.id), eq(schema.decisionLog.action, 'stock.reissued_for_deliveries')));
      expect(log).toHaveLength(1);
      // Nothing more to do for it, and its stock is not counted back twice.
      await applyAll();
      expect(await onHand(o.a)).toBe(50);
      expect(await heldFor(o.id, o.a)).toBe(5);
      // From now on its delivery issues the stock when it goes out, like an order paid today.
      const id = await made(o);
      await runTo(id);
      expect(await onHand(o.a)).toBe(45);
      expect(await onHand(o.b)).toBe(48);
    });

    it('leaves goods that have already gone issued, and counts back only what has not left', async () => {
      const o = await order();
      await fulfilOrder(o.id);
      const sent = await made(o, [{ productId: o.a, quantity: 3 }]);
      await runTo(sent);
      expect(await onHand(o.a)).toBe(45);
      await on('dispatch');
      await applyAll();
      // Three have left with the delivery; the other two, and both of the other product, are back on the books and held.
      expect(await onHand(o.a)).toBe(47);
      expect(await heldFor(o.id, o.a)).toBe(2);
      expect(await onHand(o.b)).toBe(50);
      const rest = await made(o);
      await runTo(rest);
      expect(await onHand(o.a)).toBe(45);
      expect(await onHand(o.b)).toBe(48);
    });

    it('treats goods on the road as not yet gone when the shop issues on arrival', async () => {
      const o = await order();
      await fulfilOrder(o.id);
      const onRoad = await made(o);
      await runTo(onRoad);
      await on('delivery');
      await applyAll();
      expect(await onHand(o.a)).toBe(50);
      expect(await heldFor(o.id, o.a)).toBe(5);
      await arrive(onRoad);
      expect(await onHand(o.a)).toBe(45);
    });

    it('does not touch a collected order, an unpaid one, or anything when the shop issues at payment', async () => {
      const collected = await order({ method: 'pickup' });
      await fulfilOrder(collected.id);
      const unpaid = await order({ pay: false });
      await on('dispatch');
      await applyAll();
      expect(await onHand(collected.a)).toBe(45);
      expect(await onHand(unpaid.a)).toBe(50);
      expect(await heldFor(unpaid.id, unpaid.a)).toBe(5);
      await on('payment');
      expect(await c.stockReissue.preview(companyId, 'payment')).toMatchObject({ orders: 0, quantity: 0 });
      expect(await c.stockReissue.apply({ companyId, userId: 'dispatcher-1' }, 'payment')).toEqual({ orders: 0, quantity: 0, remaining: 0, skipped: [] });
    });

    it('skips an order it cannot do, says which and why, and still does the others', async () => {
      const stuck = await order();
      await fulfilOrder(stuck.id);
      await db.update(schema.stockLocations).set({ isActive: false }).where(inArray(schema.stockLocations.id, madeLocations.slice(-1)));
      const fine = await order();
      await fulfilOrder(fine.id);
      await on('dispatch');
      const out = await c.stockReissue.apply({ companyId, userId: 'dispatcher-1' }, 'dispatch');
      expect(out.skipped.some((k) => k.orderId === stuck.id && k.message.includes('stopped'))).toBe(true);
      expect(await onHand(stuck.a)).toBe(45);
      // The others are done, and the skipped one is passed over on the next call instead of blocking it.
      await applyAll();
      expect(await onHand(fine.a)).toBe(50);
    });

    it('is done through the actions only by someone who may switch stock over', async () => {
      const o = await order();
      await fulfilOrder(o.id);
      await on('dispatch');
      requirePermission.mockImplementation((p: string) => (p === 'deliveries:read' ? Promise.resolve('reader-1') : Promise.reject(Object.assign(new Error('denied'), { name: 'AccessDeniedError' }))));
      expect(await actions.stockReissuePreviewAction()).toMatchObject({ ok: false });
      expect(await actions.stockReissueApplyAction()).toMatchObject({ ok: false });
      expect(await onHand(o.a)).toBe(45);
      requirePermission.mockResolvedValue('dispatcher-1');
      expect(await actions.stockReissuePreviewAction()).toMatchObject({ ok: true });
      let left = 1;
      for (let pass = 0; pass < 20 && left > 0; pass += 1) {
        const r = await actions.stockReissueApplyAction();
        left = r.ok ? r.data.remaining : 0;
      }
      expect(await onHand(o.a)).toBe(50);
    });
  });
});
