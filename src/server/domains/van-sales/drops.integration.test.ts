import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { holdLedgerSwitch, settleFinanceBacklog } from '@/server/domains/stock/test-support';
import { VAN_SALES_DEFAULTS } from '@/lib/van-sales/settings';
import { dayNumber, maskOf, weekdayIndex } from '@/lib/van-sales/visits';

/**
 * Deliveries from the van (database): a pre-sold order added to a van day, its delivery planned from the order's branch, counted in the load,
 * its stock set aside when the load ships and held on the van when the rep signs; and the database refuses wrong values on its own.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const firstMonday = (): string => {
  let d = addDays(businessDate(), 7);
  while (weekdayIndex(dayNumber(d) ?? 0) !== 0) d = addDays(d, 1);
  return d;
};

describe.skipIf(url === undefined || url === '')('deliveries from the van (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let release: () => Promise<void> = () => Promise.resolve();
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let warehouse: string;
  const actor: Actor = { type: 'user', id: 'sale-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const tag = randomUUID().slice(0, 6);
  let seq = 0;
  const next = () => ++seq;
  const name = (base: string) => `${base} ${tag}${String(next())}`;
  const monday = firstMonday();
  const noLimits = { maxDiscountPercent: 0, maxCreditPerDay: 0, mayOverridePrice: false, maySellOnCredit: false };

  const person = async () => {
    const [u] = await db.insert(schema.users).values({ email: `sl-${randomUUID().slice(0, 8)}@sale.test`, passwordHash: 'x', name: name('SRep'), role: 'super_admin' }).returning();
    if (u === undefined) throw new Error('no user');
    return u;
  };
  const as = (user: { id: string }): Actor => ({ type: 'user', id: user.id });
  const customer = async (over: Partial<typeof schemaModule.customers.$inferInsert> = {}) => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `SL${tag}${String(next())}`.toUpperCase(), name: name('Duka'), accountType: 'cash', ...over }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  const at = async (productId: string, locationId: string) => (await db.select({ n: schema.stockBalances.onHand, r: schema.stockBalances.reserved }).from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, locationId))).limit(1))[0] ?? { n: 0, r: 0 };
  const refusedBy = async (p: Promise<unknown>) => {
    const e = (await p.then(() => null, (err: unknown) => err)) as { message?: string; cause?: { message?: string } } | null;
    return e === null ? null : `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  };

  /** A planned day (route with both modes and a van) with two customers on its visits, a product at the warehouse, and the rep. */
  const plannedDay = async (over: { warehouseStock?: number; mode?: string } = {}) => {
    const mode = over.mode ?? 'both';
    const user = await person();
    const rep = await c.salesReps.create(companyId, actor, { userId: user.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: noLimits });
    const van = mode === 'pre_sell' ? null : await c.vans.create(companyId, actor, { name: name('DVan'), branchId, vehicleId: null, cashAccountId: null, maxCash: null });
    const route = await c.salesRoutes.create(companyId, actor, { code: `D${tag}${String(next())}`.toUpperCase(), name: name('DRoute'), branchId, mode, defaultVanId: van?.id ?? null, defaultRepId: rep.id });
    const a = await customer({ email: `dr-${randomUUID().slice(0, 8)}@drop.test`, phone: '0711000888', street: '5 Lane', city: 'Ruiru', countyOrState: 'Kiambu', country: 'Kenya' });
    const b = await customer();
    for (const x of [a, b]) await c.salesRoutes.addStop(companyId, actor, route.id, { customerId: x.id, visitDays: maskOf([0]), every: 1, anchor: monday, note: '' });
    const p = `prod_${randomUUID()}`;
    const q = `prod_${randomUUID()}`;
    for (const [id, label] of [[p, 'Crate'], [q, 'Bottle']] as const) {
      await db.insert(schema.products).values({ id, sku: `DR-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `DRS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: name(label), slug: `dr-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50' });
      await db.transaction(async (tx) => await c.stockLedger.post(tx, { companyId, productId: id, locationId: warehouse, type: 'receipt', quantity: over.warehouseStock ?? 100, unitCost: 50, actor: { type: 'user', id: 'seed' }, note: 'seed' }));
    }
    const day = (await c.vanDays.plan(companyId, actor, { routeId: route.id, date: monday })).day;
    return { user, rep, van, route, a, b, p, q, day };
  };
  type Planned = Awaited<ReturnType<typeof plannedDay>>;
  /** A sales order for a customer, holding its stock at the warehouse, as a rep's order at a visit does. */
  const orderFor = async (s: Planned, customerId: string, productId: string, quantity: number, kind: 'sales_order' | 'credit_sale' = 'sales_order') => {
    const placed = await c.salesOrders.place(companyId, { userId: s.user.id, branchId }, { customerId, lines: [{ productId, quantity }], paymentMethod: 'counter', neededOn: '', holdUntilPaid: false }, kind);
    if (!placed.ok) throw new Error(placed.error);
    return placed;
  };
  const drops = async (s: Planned) => await c.vanDrops.forDay(companyId, s.day.id);
  const load = async (s: Planned, lines: { productId: string; quantity: number }[]) => (await c.vanLoads.create(companyId, actor, s.day.id, { kind: 'load', fromLocationId: warehouse, lines })).at(-1);

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    release = await holdLedgerSwitch(url);
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    itemTypeId = `it_sl_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const [branch] = await db.insert(schema.branches).values({ companyId, name: name('Sale branch'), code: `SB${tag}${String(next())}`.toUpperCase().slice(0, 10) } as never).returning();
    branchId = branch?.id ?? '';
    warehouse = (await c.stockLocations.create(companyId, { code: `SW${tag}`.toUpperCase(), name: `Sale warehouse ${tag}`, kind: 'warehouse', branchId })).id;
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    const now = await c.vanSalesSettings.screen(companyId);
    await c.vanSalesSettings.save(companyId, actor, { ...VAN_SALES_DEFAULTS, ...now.settings, vanSell: true, preSell: true, position: 'record', offRoute: 'allow' }, now.version, reason);
  }, 120_000);

  afterAll(async () => {
    await db.update(schema.vanDays).set({ status: 'cancelled', statusReason: 'Cleared after a test run' }).where(sql`${schema.vanDays.status} IN ('planned','loading','out','returning','reconciling')`);
    await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared after a test run' }).where(eq(schema.salesRoutes.status, 'active'));
    await db.update(schema.shifts).set({ status: 'closed', closedAt: new Date(), closedBy: 'test', declaredCash: '0', zNumber: `Z-SL-${tag}` }).where(sql`${schema.shifts.status} IN ('open','closing') AND ${schema.shifts.openedBy} IN (SELECT id::text FROM users WHERE email LIKE '%@sale.test')`).catch(() => undefined);
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
    await release();
  }, 120_000);


  describe('adding an order to the day', () => {
    it('plans the order\'s delivery from its branch, ties it to the customer\'s visit and counts it in the load', async () => {
      const s = await plannedDay();
      const placed = await orderFor(s, s.a.id, s.p, 4);
      expect((await at(s.p, warehouse)).r).toBeGreaterThanOrEqual(4);
      await c.vanDrops.add(companyId, actor, s.day.id, placed.orderId);
      const [plan] = await db.select().from(schema.orderDeliveries).where(eq(schema.orderDeliveries.orderId, placed.orderId));
      expect(plan).toMatchObject({ method: 'own_fleet', branchId, destination: { address: { county: 'Kiambu', town: 'Ruiru', area: '5 Lane' } } });
      const [drop] = await drops(s);
      expect(drop).toMatchObject({ orderNumber: placed.orderNumber, customerName: s.a.name, state: 'planned', stock: 'at_warehouse', removable: true, lines: [{ productId: s.p, quantity: 4 }] });
      const detail = await c.vanDays.find(companyId, s.day.id);
      expect(detail?.visits.map((v) => v.id)).toContain(drop?.visitId);
      expect(detail?.events.at(-1)).toMatchObject({ action: 'day.drop_added', words: 'An order was added to the deliveries' });
      // The load planner counts it, though the warehouse's own hold is still on the shelf.
      const plan2 = await c.vanLoads.suggest(companyId, s.day.id, warehouse);
      expect(plan2.rows).toEqual([expect.objectContaining({ productId: s.p, drops: 4, wanted: 4, loadable: 4, short: 0 })]);
    });

    it('refuses what cannot be delivered from the van, and says why', async () => {
      const s = await plannedDay();
      const other = await customer();
      await expect(c.vanDrops.add(companyId, actor, s.day.id, (await orderFor(s, other.id, s.p, 1)).orderId)).rejects.toThrow('not on this day\'s visits');
      const onAccount = await customer({ accountType: 'credit', creditLimit: '100000', paymentTermDays: 30, email: `dr-${randomUUID().slice(0, 8)}@drop.test`, phone: '0711000999', street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' });
      await expect(c.vanDrops.add(companyId, actor, s.day.id, (await orderFor(s, onAccount.id, s.p, 1, 'credit_sale')).orderId)).rejects.toThrow('not a sales order');
      await expect(c.vanDrops.add(companyId, actor, s.day.id, 'nope')).rejects.toThrow('could not be found');
      const placed = await orderFor(s, s.a.id, s.p, 1);
      await db.update(schema.orders).set({ status: 'cancelled' }).where(eq(schema.orders.id, placed.orderId));
      await expect(c.vanDrops.add(companyId, actor, s.day.id, placed.orderId)).rejects.toThrow('cancelled');
      const again = await orderFor(s, s.a.id, s.p, 2);
      await c.vanDrops.add(companyId, actor, s.day.id, again.orderId);
      await expect(c.vanDrops.add(companyId, actor, s.day.id, again.orderId)).rejects.toThrow('already on a delivery');
      expect(await drops(s)).toHaveLength(1);
    });

    it('is refused for an order whose stock was already issued', async () => {
      const s = await plannedDay();
      const placed = await orderFor(s, s.a.id, s.p, 2);
      await c.stockReservations.consume({ companyId, refType: 'order', refId: placed.orderId, actor: 'test' });
      await expect(c.vanDrops.add(companyId, actor, s.day.id, placed.orderId)).rejects.toThrow('no longer holds stock');
    });

    it('is refused on a day with no van, and once the day has gone out', async () => {
      const s = await plannedDay();
      const placed = await orderFor(s, s.a.id, s.p, 1);
      await db.update(schema.vanDays).set({ status: 'out' }).where(eq(schema.vanDays.id, s.day.id));
      await expect(c.vanDrops.add(companyId, actor, s.day.id, placed.orderId)).rejects.toThrow('before the day goes out');
      const pre = await plannedDay({ mode: 'pre_sell' });
      await expect(c.vanDrops.add(companyId, actor, pre.day.id, (await orderFor(pre, pre.a.id, pre.p, 1)).orderId)).rejects.toThrow('with a van');
    });

    it('can be taken off the day while its stock is still at the warehouse', async () => {
      const s = await plannedDay();
      const placed = await orderFor(s, s.a.id, s.p, 2);
      await c.vanDrops.add(companyId, actor, s.day.id, placed.orderId);
      const [drop] = await drops(s);
      await c.vanDrops.remove(companyId, actor, s.day.id, drop?.id ?? '');
      expect(await drops(s)).toEqual([]);
      expect((await c.vanDays.find(companyId, s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.drop_removed' });
      await c.vanDrops.add(companyId, actor, s.day.id, placed.orderId);
    });
  });

  describe('the stock, with the load', () => {
    it('is set aside when the load ships, without a cancellation entry, and held on the van when the rep signs', async () => {
      const s = await plannedDay();
      const placed = await orderFor(s, s.a.id, s.p, 4);
      await c.vanDrops.add(companyId, actor, s.day.id, placed.orderId);
      const before = await at(s.p, warehouse);
      const made = await load(s, [{ productId: s.p, quantity: 4 }]);
      await c.vanLoads.ship(companyId, actor, made?.id ?? '');
      const [moving] = await drops(s);
      expect(moving).toMatchObject({ stock: 'on_the_way', removable: false });
      // The shelves gave up the order's hold and the four units; nothing was journalled as a cancellation.
      const left = await at(s.p, warehouse);
      expect(left.r).toBe(before.r - 4);
      expect(left.n).toBe(before.n - 4);
      const journal = await db.select().from(schema.inventoryMovements).where(and(eq(schema.inventoryMovements.referenceId, placed.orderId), eq(schema.inventoryMovements.changeType, 'order_cancellation_release')));
      expect(journal).toEqual([]);
      await c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, { maySell: true, mayPlan: false });
      const [onVan] = await drops(s);
      expect(onVan).toMatchObject({ stock: 'on_van' });
      const vanBalance = await at(s.p, (s.van?.locationId ?? ''));
      expect(vanBalance).toEqual({ n: 4, r: 4 });
      const holds = await db.select().from(schema.stockReservations).where(and(eq(schema.stockReservations.refId, placed.orderId), eq(schema.stockReservations.state, 'held')));
      expect(holds).toEqual([expect.objectContaining({ locationId: (s.van?.locationId ?? ''), quantity: 4 })]);
      const events = (await c.vanDays.find(companyId, s.day.id))?.events.map((e) => e.action) ?? [];
      expect(events).toEqual(expect.arrayContaining(['day.drop_on_the_way', 'day.drop_on_van']));
    });

    it('is put back at the warehouse when the load cannot ship', async () => {
      const s = await plannedDay();
      const placed = await orderFor(s, s.a.id, s.p, 4);
      await c.vanDrops.add(companyId, actor, s.day.id, placed.orderId);
      const made = await load(s, [{ productId: s.p, quantity: 4 }, { productId: s.q, quantity: 50 }]);
      // The second product cannot go: the warehouse is left with less than the load asks for.
      await db.update(schema.stockBalances).set({ onHand: 1 }).where(and(eq(schema.stockBalances.productId, s.q), eq(schema.stockBalances.locationId, warehouse)));
      const heldBefore = (await at(s.p, warehouse)).r;
      await expect(c.vanLoads.ship(companyId, actor, made?.id ?? '')).rejects.toThrow();
      const [drop] = await drops(s);
      expect(drop).toMatchObject({ stock: 'at_warehouse', removable: true });
      expect((await at(s.p, warehouse)).r).toBe(heldBefore);
      expect((await c.vanDays.find(companyId, s.day.id))?.events.map((e) => e.action)).toEqual(expect.arrayContaining(['day.drop_on_the_way', 'day.drop_put_back']));
    });

    it('stays at the warehouse when the load does not cover the whole order, and is marked short when the rep signs for less', async () => {
      const s = await plannedDay();
      const placed = await orderFor(s, s.a.id, s.p, 4);
      await c.vanDrops.add(companyId, actor, s.day.id, placed.orderId);
      const small = await load(s, [{ productId: s.p, quantity: 3 }]);
      await c.vanLoads.ship(companyId, actor, small?.id ?? '');
      expect((await drops(s))[0]).toMatchObject({ stock: 'at_warehouse' });
      await c.vanLoads.sign(companyId, as(s.user), small?.id ?? '', {}, { maySell: true, mayPlan: false });
      expect((await drops(s))[0]).toMatchObject({ stock: 'at_warehouse' });
      const s2 = await plannedDay();
      const placed2 = await orderFor(s2, s2.a.id, s2.p, 4);
      await c.vanDrops.add(companyId, actor, s2.day.id, placed2.orderId);
      const full = await load(s2, [{ productId: s2.p, quantity: 4 }]);
      await c.vanLoads.ship(companyId, actor, full?.id ?? '');
      await c.vanLoads.sign(companyId, as(s2.user), full?.id ?? '', { entries: [{ productId: s2.p, quantity: 2 }] }, { maySell: true, mayPlan: false });
      expect((await drops(s2))[0]).toMatchObject({ stock: 'short', stockWords: 'Not on the van: the load came short' });
      expect((await c.vanDays.find(companyId, s2.day.id))?.events.at(-1)).toMatchObject({ action: 'day.drop_short' });
    });
  });

  describe('delivering at the visit', () => {
    let moment = 'payment';
    beforeAll(async () => {
      moment = (await c.stockSettings.get()).issueMoment;
      await c.stockSettings.setIssueMoment(companyId, 'delivery');
    });
    afterAll(async () => {
      await c.stockSettings.setIssueMoment(companyId, moment);
    });

    /** A day that is out with an order's stock on the van, the rep at the first customer. */
    const outWithDrop = async (over: { paid?: boolean; quantity?: number } = {}) => {
      const s = await plannedDay();
      const placed = await orderFor(s, s.a.id, s.p, over.quantity ?? 4);
      if (over.paid !== false) await db.update(schema.orders).set({ paymentStatus: 'paid' }).where(eq(schema.orders.id, placed.orderId));
      await c.vanDrops.add(companyId, actor, s.day.id, placed.orderId);
      const made = await load(s, [{ productId: s.p, quantity: over.quantity ?? 4 }]);
      await c.vanLoads.ship(companyId, actor, made?.id ?? '');
      await c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, { maySell: true, mayPlan: false });
      const ver = (await c.vanDays.find(companyId, s.day.id))?.day.version;
      await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: ver }, true);
      const visit = (await c.vanDays.find(companyId, s.day.id))?.visits.find((v) => v.customerName === s.a.name);
      return { s, placed, visit };
    };
    const arrive = async (x: Awaited<ReturnType<typeof outWithDrop>>) => await c.vanRun.arrive(companyId, as(x.s.user), x.s.day.id, x.visit?.id ?? '', {}, true);

    it('delivers the order from the van through a delivery document, issuing the stock from the van and finishing the visit as delivered only', async () => {
      const x = await outWithDrop();
      const [drop] = await drops(x.s);
      await expect(c.vanDrops.deliver(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', { receivedBy: 'Mama Njeri' }, true)).rejects.toThrow(`Arrive at ${x.s.a.name}`);
      await arrive(x);
      await expect(c.vanDrops.deliver(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', { receivedBy: '' }, true)).rejects.toThrow('Say who received');
      await expect(c.vanDrops.deliver(companyId, actor, x.s.day.id, drop?.id ?? '', { receivedBy: 'Mama Njeri' }, true)).rejects.toThrow('runs their own day');
      await expect(c.vanRun.finish(companyId, as(x.s.user), x.s.day.id, x.visit?.id ?? '', { outcome: 'sold' }, true)).rejects.toThrow('not dealt with');
      await c.vanDrops.deliver(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', { receivedBy: 'Mama Njeri' }, true);
      const [done] = await drops(x.s);
      expect(done).toMatchObject({ state: 'delivered', stateWords: 'Delivered', removable: false });
      const [doc] = await db.select().from(schema.deliveries).where(eq(schema.deliveries.orderId, x.placed.orderId));
      expect(doc).toMatchObject({ status: 'delivered', receivedBy: 'Mama Njeri', method: 'own_fleet' });
      const [row] = await db.select().from(schema.vanDrops).where(eq(schema.vanDrops.id, drop?.id ?? ''));
      expect(row?.deliveryId).toBe(doc?.id);
      // The van gave up the four units and the order's hold on it is gone.
      expect(await at(x.s.p, x.s.van?.locationId ?? '')).toEqual({ n: 0, r: 0 });
      const open = await db.select().from(schema.stockReservations).where(and(eq(schema.stockReservations.refId, x.placed.orderId), sql`${schema.stockReservations.state} IN ('held','partly_consumed')`));
      expect(open).toEqual([]);
      // The order's own timeline shows the delivery.
      const stages = await db.select().from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, x.placed.orderId));
      expect(stages.map((e) => e.stage)).toEqual(expect.arrayContaining(['delivered']));
      expect((await c.vanDays.find(companyId, x.s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.drop_delivered', words: 'An order was delivered' });
      // Delivering again changes nothing.
      await expect(c.vanDrops.deliver(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', { receivedBy: 'Mama Njeri' }, true)).rejects.toThrow('already been dealt with');
      const finished = await c.vanRun.finish(companyId, as(x.s.user), x.s.day.id, x.visit?.id ?? '', { outcome: 'sold' }, true);
      expect(finished.visits.find((v) => v.id === x.visit?.id)).toMatchObject({ status: 'done', outcome: 'delivered_only' });
    });

    it('is left where it got to, with the reason, when the order has not been paid for, and carries on once it is', async () => {
      const x = await outWithDrop({ paid: false });
      await arrive(x);
      const [drop] = await drops(x.s);
      await expect(c.vanDrops.deliver(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', { receivedBy: 'Mama Njeri' }, true)).rejects.toThrow('not been paid for');
      expect((await drops(x.s))[0]).toMatchObject({ state: 'planned' });
      expect(await at(x.s.p, x.s.van?.locationId ?? '')).toEqual({ n: 4, r: 4 });
      await db.update(schema.orders).set({ paymentStatus: 'paid' }).where(eq(schema.orders.id, x.placed.orderId));
      await c.vanDrops.deliver(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', { receivedBy: 'Mama Njeri' }, true);
      expect((await drops(x.s))[0]).toMatchObject({ state: 'delivered' });
      expect((await db.select().from(schema.deliveries).where(eq(schema.deliveries.orderId, x.placed.orderId)))).toHaveLength(1);
    });

    it('is closed as refused, or as not delivered, with a reason, and the stock stays held on the van', async () => {
      const x = await outWithDrop();
      await arrive(x);
      const [drop] = await drops(x.s);
      await expect(c.vanDrops.close(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', 'refused', 'no', true)).rejects.toThrow('Say why');
      await c.vanDrops.close(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', 'refused', 'The shop says it ordered less', true);
      expect((await drops(x.s))[0]).toMatchObject({ state: 'refused', stateWords: 'Refused', reason: 'The shop says it ordered less', stock: 'on_van' });
      expect(await at(x.s.p, x.s.van?.locationId ?? '')).toEqual({ n: 4, r: 4 });
      expect((await c.vanDays.find(companyId, x.s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.drop_refused' });
      await expect(c.vanDrops.close(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', 'failed', 'Locked shop', true)).rejects.toThrow('already been dealt with');
      // With every delivery dealt with, the visit can be finished with no sale.
      const finished = await c.vanRun.finish(companyId, as(x.s.user), x.s.day.id, x.visit?.id ?? '', { outcome: 'no_sale', reason: 'Refused the delivery' }, true);
      expect(finished.visits.find((v) => v.id === x.visit?.id)).toMatchObject({ outcome: 'no_sale' });
      // A refused order can be put on another day's deliveries again.
      const next = await plannedDay();
      expect(next.day.id).not.toBe(x.s.day.id);
    });
  });

  describe('held by the database itself', () => {
    it('refuses wrong values and a second live delivery of one order', async () => {
      const s = await plannedDay();
      const placed = await orderFor(s, s.a.id, s.p, 1);
      await c.vanDrops.add(companyId, actor, s.day.id, placed.orderId);
      const [drop] = await drops(s);
      const bad = async (set: string) => await refusedBy(db.execute(sql.raw(`UPDATE van_drops SET ${set} WHERE id = '${drop?.id ?? ''}'`)));
      expect(await bad("state = 'lost'")).toContain('van_drops_state_chk');
      expect(await bad("stock_state = 'gone'")).toContain('van_drops_stock_chk');
      expect(await bad("state = 'refused'")).toContain('van_drops_reason_chk');
      expect(await bad("state = 'refused', reason = 'no'")).toContain('van_drops_reason_chk');
      expect(await refusedBy(db.insert(schema.vanDrops).values({ companyId, dayId: s.day.id, visitId: drop?.visitId ?? '', orderId: placed.orderId, createdBy: 'x' }))).toContain('van_drops_live_order_uidx');
    });
  });
});
