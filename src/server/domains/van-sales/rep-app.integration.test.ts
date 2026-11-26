import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { holdLedgerSwitch, settleFinanceBacklog } from '@/server/domains/stock/test-support';
import { VAN_SALES_DEFAULTS } from '@/lib/van-sales/settings';
import { dayNumber, maskOf, weekdayIndex } from '@/lib/van-sales/visits';

/**
 * The rep app (database): the days that are a rep's own to run, how far along they are, the customer's map pin on a visit, and what a customer
 * last bought through a van.
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

describe.skipIf(url === undefined || url === '')('the rep app (database)', () => {
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

  /** A planned day (route with both modes and a van) with two customers on its visits, a product at the warehouse, and the rep. */
  const plannedDay = async (over: { warehouseStock?: number; mode?: string; date?: string } = {}) => {
    const mode = over.mode ?? 'both';
    const user = await person();
    const rep = await c.salesReps.create(companyId, actor, { userId: user.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: noLimits });
    const van = mode === 'pre_sell' ? null : await c.vans.create(companyId, actor, { name: name('DVan'), branchId, vehicleId: null, cashAccountId: null, maxCash: null });
    const route = await c.salesRoutes.create(companyId, actor, { code: `D${tag}${String(next())}`.toUpperCase(), name: name('DRoute'), branchId, mode, defaultVanId: van?.id ?? null, defaultRepId: rep.id });
    const a = await customer({ email: `dr-${randomUUID().slice(0, 8)}@drop.test`, phone: '0711000888', street: '5 Lane', city: 'Ruiru', countyOrState: 'Kiambu', country: 'Kenya' });
    const b = await customer();
    for (const x of [a, b]) await c.salesRoutes.addStop(companyId, actor, route.id, { customerId: x.id, visitDays: maskOf([0]), every: 1, anchor: over.date ?? monday, note: '' });
    const p = `prod_${randomUUID()}`;
    const q = `prod_${randomUUID()}`;
    for (const [id, label] of [[p, 'Crate'], [q, 'Bottle']] as const) {
      await db.insert(schema.products).values({ id, sku: `DR-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `DRS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: name(label), slug: `dr-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50' });
      await db.transaction(async (tx) => await c.stockLedger.post(tx, { companyId, productId: id, locationId: warehouse, type: 'receipt', quantity: over.warehouseStock ?? 100, unitCost: 50, actor: { type: 'user', id: 'seed' }, note: 'seed' }));
    }
    const day = (await c.vanDays.plan(companyId, actor, { routeId: route.id, date: over.date ?? monday })).day;
    return { user, rep, van, route, a, b, p, q, day };
  };
  type Planned = Awaited<ReturnType<typeof plannedDay>>;

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


  /** The first Monday within the coming week: a day planned on it, or a week later, is inside what the rep's phone shows. */
  const soon = (() => {
    let d = addDays(businessDate(), 1);
    while (weekdayIndex(dayNumber(d) ?? 0) !== 0) d = addDays(d, 1);
    return d;
  })();
  const send = async (s: Planned) => await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: (await c.vanDays.find(companyId, s.day.id))?.day.version }, true);

  describe('the days that are a rep\'s own', () => {
    it('is nothing for a person who is not set up as a rep', async () => {
      expect(await c.repApp.myDays(companyId, (await person()).id)).toBeNull();
    });

    it('lists the days to run, with how far along they are and who is next', async () => {
      const s = await plannedDay({ mode: 'pre_sell', date: soon });
      const planned = await c.repApp.myDays(companyId, s.user.id);
      expect(planned?.repName).toBe(s.rep.name);
      expect(planned?.today).toBe(businessDate());
      expect(planned?.days).toEqual([expect.objectContaining({ id: s.day.id, number: s.day.number, date: soon, isToday: false, routeName: s.route.name, vanName: null, status: 'planned', visits: 2, visitsDone: 0, next: null })]);
      await send(s);
      const out = (await c.repApp.myDays(companyId, s.user.id))?.days[0];
      expect(out).toMatchObject({ status: 'out', statusWords: 'Out on the route', visitsDone: 0, next: s.a.name });
      const visits = (await c.vanDays.find(companyId, s.day.id))?.visits ?? [];
      await c.vanRun.arrive(companyId, as(s.user), s.day.id, visits[0]?.id ?? '', {}, true);
      expect((await c.repApp.myDays(companyId, s.user.id))?.days[0]).toMatchObject({ next: s.a.name, visitsDone: 0 });
      await c.vanRun.finish(companyId, as(s.user), s.day.id, visits[0]?.id ?? '', { outcome: 'no_sale', reason: 'Nothing wanted' }, true);
      expect((await c.repApp.myDays(companyId, s.user.id))?.days[0]).toMatchObject({ visitsDone: 1, next: s.b.name });
    });

    it('leaves out days that are over or cancelled, other people\'s days and days beyond the coming fortnight', async () => {
      const s = await plannedDay({ mode: 'pre_sell', date: soon });
      const far = await plannedDay({ mode: 'pre_sell', date: addDays(soon, 14) });
      expect((await c.repApp.myDays(companyId, far.user.id))?.days).toEqual([]);
      await db.update(schema.vanDays).set({ status: 'cancelled', statusReason: 'Not needed' }).where(eq(schema.vanDays.id, s.day.id));
      expect((await c.repApp.myDays(companyId, s.user.id))?.days).toEqual([]);
      const other = await plannedDay({ mode: 'pre_sell', date: soon });
      expect((await c.repApp.myDays(companyId, s.user.id))?.days).toEqual([]);
      expect((await c.repApp.myDays(companyId, other.user.id))?.days.map((d) => d.id)).toEqual([other.day.id]);
    });
  });

  describe('a customer on a visit', () => {
    it('carries the customer\'s map pin for directions, when there is one', async () => {
      const s = await plannedDay({ mode: 'pre_sell', date: soon });
      await db.insert(schema.customerAddresses).values({ customerId: s.a.id, label: 'Shop', recipientName: 'Shopkeeper', recipientPhone: '0712000111', street: '5 Lane', city: 'Ruiru', countyOrState: 'Kiambu', country: 'Kenya', latitude: '-1.146500', longitude: '36.960000', isDefault: true } as never);
      const visits = (await c.vanDays.find(companyId, s.day.id))?.visits ?? [];
      expect(visits.find((v) => v.customerId === s.a.id)?.pin).toEqual({ lat: -1.1465, lng: 36.96 });
      expect(visits.find((v) => v.customerId === s.b.id)?.pin).toBeNull();
    });
  });

  describe('what a customer usually buys', () => {
    it('is what they last bought through a van on another day, only for a visit under way', async () => {
      const first = await plannedDay({ mode: 'pre_sell', date: soon });
      await send(first);
      const fv = (await c.vanDays.find(companyId, first.day.id))?.visits.find((v) => v.customerId === first.a.id);
      await c.vanRun.arrive(companyId, as(first.user), first.day.id, fv?.id ?? '', {}, true);
      const made = await c.vanSales.order(companyId, as(first.user), first.day.id, { visitId: fv?.id, saleKey: randomUUID(), neededOn: '', lines: [{ productId: first.p, quantity: 6 }, { productId: first.q, quantity: 2 }] }, true);
      // The same customer on another route and another week.
      const user = await person();
      const rep = await c.salesReps.create(companyId, actor, { userId: user.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: noLimits });
      const route = await c.salesRoutes.create(companyId, actor, { code: `U${tag}${String(next())}`.toUpperCase(), name: name('URoute'), branchId, mode: 'pre_sell', defaultVanId: null, defaultRepId: rep.id });
      await c.salesRoutes.addStop(companyId, actor, route.id, { customerId: first.a.id, visitDays: maskOf([0]), every: 1, anchor: addDays(soon, 7), note: '' });
      const secondDate = addDays(soon, 7);
      const day = (await c.vanDays.plan(companyId, actor, { routeId: route.id, date: secondDate })).day;
      await c.vanRun.sendOut(companyId, as(user), day.id, { float: 0, expectedVersion: (await c.vanDays.find(companyId, day.id))?.day.version }, true);
      expect(await c.repApp.usual(companyId, day.id)).toEqual([]);
      const visit = (await c.vanDays.find(companyId, day.id))?.visits[0];
      await c.vanRun.arrive(companyId, as(user), day.id, visit?.id ?? '', {}, true);
      const [usual] = await c.repApp.usual(companyId, day.id);
      expect(usual).toMatchObject({ visitId: visit?.id, orderNumber: made.orderNumber });
      expect(usual?.lines.map((l) => [l.productId, l.quantity])).toEqual([[first.p, 6], [first.q, 2]]);
      // The day the order was taken on has no earlier sale to offer: it is not its own usual.
      expect(await c.repApp.usual(companyId, first.day.id)).toEqual([]);
      expect(await c.repApp.usual(companyId, 'nope')).toEqual([]);
    });
  });
});
