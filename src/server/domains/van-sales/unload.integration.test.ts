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
 * Coming back and unloading (database): a day comes back once every visit and delivery is dealt with, the van is unloaded as a transfer to the
 * warehouse and received there, stock held on the van for a refused delivery goes back to the warehouse, and the office starts settling the day.
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

describe.skipIf(url === undefined || url === '')('coming back and unloading (database)', () => {
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


  /** A day that is out with 20 of one product on the van and an order of 4 of it delivered by drop to the first customer, the rep not yet back. */
  const outDay = async (over: { drop?: boolean } = {}) => {
    const s = await plannedDay();
    const placed = over.drop === true ? await orderFor(s, s.a.id, s.p, 4) : null;
    if (placed !== null) {
      await db.update(schema.orders).set({ paymentStatus: 'paid' }).where(eq(schema.orders.id, placed.orderId));
      await c.vanDrops.add(companyId, actor, s.day.id, placed.orderId);
    }
    const made = await load(s, [{ productId: s.p, quantity: placed === null ? 10 : 14 }]);
    await c.vanLoads.ship(companyId, actor, made?.id ?? '');
    await c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, { maySell: true, mayPlan: false });
    await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: (await c.vanDays.find(companyId, s.day.id))?.day.version }, true);
    const visits = (await c.vanDays.find(companyId, s.day.id))?.visits ?? [];
    return { s, visits, placed };
  };
  const back = async (x: Awaited<ReturnType<typeof outDay>>, user: { id: string } = x.s.user) => await c.vanRun.comeBack(companyId, as(user), x.s.day.id, { expectedVersion: (await c.vanDays.find(companyId, x.s.day.id))?.day.version }, true);
  const skipAll = async (x: Awaited<ReturnType<typeof outDay>>) => {
    for (const v of x.visits) await c.vanRun.skip(companyId, as(x.s.user), x.s.day.id, v.id, 'Not visited today', true);
  };
  const statusOf = async (s: Planned) => (await c.vanDays.find(companyId, s.day.id))?.day.status;
  const vanStock = async (s: Planned) => (await at(s.p, s.van?.locationId ?? '')).n;

  describe('coming back', () => {
    it('needs every visit finished or skipped and every delivery dealt with, and names what is in the way', async () => {
      const x = await outDay({ drop: true });
      await expect(back(x)).rejects.toThrow('have not been finished');
      await skipAll(x);
      await expect(back(x)).rejects.toThrow(`${x.placed?.orderNumber ?? ''} has not been delivered`);
      const [drop] = await c.vanDrops.forDay(companyId, x.s.day.id);
      await c.vanRun.arrive(companyId, as(x.s.user), x.s.day.id, drop?.visitId ?? '', {}, true).catch(() => undefined);
      expect((await c.vanRun.backProblemOf(companyId, x.s.day.id))).toContain('has not been delivered');
    });

    it('moves the day to back, for the day\'s own rep only, with an entry in its history, and stops selling', async () => {
      const x = await outDay();
      await skipAll(x);
      await expect(back(x, await person())).rejects.toThrow('runs their own day');
      await expect(c.vanRun.comeBack(companyId, as(x.s.user), x.s.day.id, { expectedVersion: 0 }, true)).rejects.toThrow('Someone else changed');
      await back(x);
      expect(await statusOf(x.s)).toBe('returning');
      expect((await c.vanDays.find(companyId, x.s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.back', words: 'The rep came back to the depot', fromStatus: 'out', toStatus: 'returning' });
      await expect(back(x)).rejects.toThrow('out on the route');
    });
  });

  describe('unloading the van', () => {
    it('sends everything on the van back to the warehouse as a transfer, and the office receives it', async () => {
      const x = await outDay();
      await skipAll(x);
      await expect(c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true)).rejects.toThrow('once the day is back');
      await back(x);
      const before = await at(x.s.p, warehouse);
      expect((await c.vanLoads.endFacts(companyId, x.s.day.id)).unloadProblem).toBeNull();
      const loads = await c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true);
      const unload = loads.find((l) => l.kind === 'unload');
      expect(unload).toMatchObject({ state: 'shipped', stateWords: 'On its way to the warehouse', cancelledAt: null });
      expect(unload?.steps).toMatchObject({ sign: true, cancel: false });
      expect(unload?.lines).toEqual([expect.objectContaining({ productId: x.s.p, asked: 10, shipped: 10 })]);
      expect(await vanStock(x.s)).toBe(0);
      await expect(c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true)).rejects.toThrow('already being unloaded');
      expect((await c.vanLoads.endFacts(companyId, x.s.day.id)).reconcileProblem).toContain('not been received');
      await expect(c.vanLoads.sign(companyId, as(x.s.user), unload?.id ?? '', {}, { maySell: true, mayPlan: false })).rejects.toThrow('received at the warehouse');
      await expect(c.vanLoads.receive(companyId, actor, unload?.id ?? '', {}, false)).rejects.toThrow('not allowed to receive');
      const received = await c.vanLoads.receive(companyId, actor, unload?.id ?? '', {}, true);
      expect(received.find((l) => l.kind === 'unload')).toMatchObject({ state: 'received', stateWords: 'Received at the warehouse' });
      expect((await at(x.s.p, warehouse)).n).toBe(before.n + 10);
      expect((await c.vanDays.find(companyId, x.s.day.id))?.events.map((e) => e.action)).toEqual(expect.arrayContaining(['day.unload_created', 'day.unload_shipped', 'day.unload_received']));
      await expect(c.vanLoads.receive(companyId, actor, unload?.id ?? '', {}, true)).rejects.toThrow('already been received');
    });

    it('leaves what the warehouse did not count in transit, as a shortage to decide', async () => {
      const x = await outDay();
      await skipAll(x);
      await back(x);
      const unload = (await c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true)).find((l) => l.kind === 'unload');
      await expect(c.vanLoads.receive(companyId, actor, unload?.id ?? '', { entries: [{ productId: x.s.p, quantity: 11 }] }, true)).rejects.toThrow('Only 10');
      await expect(c.vanLoads.receive(companyId, actor, unload?.id ?? '', { entries: [{ productId: 'other', quantity: 1 }] }, true)).rejects.toThrow('not on this unload');
      const received = (await c.vanLoads.receive(companyId, actor, unload?.id ?? '', { entries: [{ productId: x.s.p, quantity: 7 }] }, true)).find((l) => l.kind === 'unload');
      expect(received?.lines).toEqual([expect.objectContaining({ received: 7, inTransit: 3 })]);
      const event = (await c.vanDays.find(companyId, x.s.day.id))?.events.find((e) => e.action === 'day.unload_received');
      expect(event).toBeDefined();
    });

    it('is refused for a van with nothing on it', async () => {
      const x = await outDay();
      await skipAll(x);
      await db.update(schema.stockBalances).set({ onHand: 0 }).where(and(eq(schema.stockBalances.productId, x.s.p), eq(schema.stockBalances.locationId, x.s.van?.locationId ?? '')));
      await back(x);
      await expect(c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true)).rejects.toThrow('empty');
      expect((await c.vanLoads.endFacts(companyId, x.s.day.id)).reconcileProblem).toBeNull();
    });
  });

  describe('a refused delivery', () => {
    it('has its stock set aside for the unload and held at the warehouse again when it is received', async () => {
      const x = await outDay({ drop: true });
      const [drop] = await c.vanDrops.forDay(companyId, x.s.day.id);
      const aVisit = x.visits.find((v) => v.id === drop?.visitId);
      await c.vanRun.arrive(companyId, as(x.s.user), x.s.day.id, aVisit?.id ?? '', {}, true);
      await c.vanDrops.close(companyId, as(x.s.user), x.s.day.id, drop?.id ?? '', 'refused', 'The shop says it ordered less', true);
      await c.vanRun.finish(companyId, as(x.s.user), x.s.day.id, aVisit?.id ?? '', { outcome: 'no_sale', reason: 'Refused the delivery' }, true);
      for (const v of x.visits.filter((v) => v.id !== aVisit?.id)) await c.vanRun.skip(companyId, as(x.s.user), x.s.day.id, v.id, 'Not visited today', true);
      await back(x);
      expect(await at(x.s.p, x.s.van?.locationId ?? '')).toEqual({ n: 14, r: 4 });
      const unload = (await c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true)).find((l) => l.kind === 'unload');
      expect((await c.vanDrops.forDay(companyId, x.s.day.id))[0]).toMatchObject({ state: 'refused', stock: 'on_the_way' });
      expect(unload?.lines).toEqual([expect.objectContaining({ asked: 14, shipped: 14 })]);
      expect(await at(x.s.p, x.s.van?.locationId ?? '')).toEqual({ n: 0, r: 0 });
      const warehouseBefore = await at(x.s.p, warehouse);
      await c.vanLoads.receive(companyId, actor, unload?.id ?? '', {}, true);
      // The order is held at the warehouse again, as it was before it went on the van.
      expect((await c.vanDrops.forDay(companyId, x.s.day.id))[0]).toMatchObject({ state: 'refused', stock: 'at_warehouse' });
      const after = await at(x.s.p, warehouse);
      expect(after.n).toBe(warehouseBefore.n + 14);
      expect(after.r).toBe(warehouseBefore.r + 4);
      const holds = await db.select().from(schema.stockReservations).where(and(eq(schema.stockReservations.refId, x.placed?.orderId ?? ''), eq(schema.stockReservations.state, 'held')));
      expect(holds).toEqual([expect.objectContaining({ locationId: warehouse, quantity: 4 })]);
    });
  });

  describe('starting to settle the day', () => {
    it('needs the unload received, is for the office, and moves the day to settling', async () => {
      const x = await outDay();
      await skipAll(x);
      await back(x);
      await expect(c.vanLoads.startReconciling(companyId, actor, x.s.day.id, true)).rejects.toThrow('Unload it first');
      const unload = (await c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true)).find((l) => l.kind === 'unload');
      await expect(c.vanLoads.startReconciling(companyId, actor, x.s.day.id, true)).rejects.toThrow('not been received');
      await c.vanLoads.receive(companyId, actor, unload?.id ?? '', {}, true);
      await expect(c.vanLoads.startReconciling(companyId, actor, x.s.day.id, false)).rejects.toThrow('not allowed to settle');
      await c.vanLoads.startReconciling(companyId, actor, x.s.day.id, true);
      expect(await statusOf(x.s)).toBe('reconciling');
      expect((await c.vanDays.find(companyId, x.s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.reconciling', fromStatus: 'returning', toStatus: 'reconciling' });
      await expect(c.vanLoads.startReconciling(companyId, actor, x.s.day.id, true)).rejects.toThrow('once the day is back');
    });

    it('is open to a day that only takes orders, with no van to unload', async () => {
      const s = await plannedDay({ mode: 'pre_sell' });
      await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: (await c.vanDays.find(companyId, s.day.id))?.day.version }, true);
      for (const v of (await c.vanDays.find(companyId, s.day.id))?.visits ?? []) await c.vanRun.skip(companyId, as(s.user), s.day.id, v.id, 'Not visited today', true);
      await c.vanRun.comeBack(companyId, as(s.user), s.day.id, { expectedVersion: (await c.vanDays.find(companyId, s.day.id))?.day.version }, true);
      await c.vanLoads.startReconciling(companyId, actor, s.day.id, true);
      expect(await statusOf(s)).toBe('reconciling');
    });
  });

  describe('held by the database itself', () => {
    it('allows one live unload for a day, and no other kind', async () => {
      const x = await outDay();
      await skipAll(x);
      await back(x);
      const unload = (await c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true)).find((l) => l.kind === 'unload');
      const [row] = await db.select().from(schema.vanLoads).where(eq(schema.vanLoads.id, unload?.id ?? ''));
      expect(await refusedBy(db.insert(schema.vanLoads).values({ companyId, dayId: x.s.day.id, kind: 'unload', transferId: row?.transferId ?? '', fromLocationId: row?.fromLocationId ?? '', createdBy: 'x' }))).toMatch(/van_loads_(day_unload|transfer)_uidx/);
      expect(await refusedBy(db.execute(sql.raw(`UPDATE van_loads SET kind = 'return' WHERE id = '${row?.id ?? ''}'`)))).toContain('van_loads_kind_chk');
    });
  });
});
