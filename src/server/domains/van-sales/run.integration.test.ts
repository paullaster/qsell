import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { holdLedgerSwitch, settleFinanceBacklog } from '@/server/domains/stock/test-support';
import { parseCount } from '@/server/domains/selling/shifts/shift-rules';
import { VAN_SALES_DEFAULTS } from '@/lib/van-sales/settings';
import { dayNumber, maskOf, weekdayIndex } from '@/lib/van-sales/visits';

/**
 * Running a van day (database): the rep sends the day out (which opens the van's till with a counted float, and needs the load signed for), and
 * works the visits (arrive with a position, finish with no sale and a reason, skip, find a shop shut, add a customer on the road where allowed).
 * Only the day's own rep does any of it. Every step is in the day's history; the database refuses wrong values on its own.
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

describe.skipIf(url === undefined || url === '')('running a van day (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let release: () => Promise<void> = () => Promise.resolve();
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let warehouse: string;
  const actor: Actor = { type: 'user', id: 'run-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const tag = randomUUID().slice(0, 6);
  let seq = 0;
  const next = () => ++seq;
  const name = (base: string) => `${base} ${tag}${String(next())}`;
  const monday = firstMonday();

  const person = async () => {
    const [u] = await db.insert(schema.users).values({ email: `rn-${randomUUID().slice(0, 8)}@run.test`, passwordHash: 'x', name: name('RRep'), role: 'super_admin' }).returning();
    if (u === undefined) throw new Error('no user');
    return u;
  };
  const as = (user: { id: string }): Actor => ({ type: 'user', id: user.id });
  const customer = async (over: Partial<typeof schemaModule.customers.$inferInsert> = {}) => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `RN${tag}${String(next())}`.toUpperCase(), name: name('Duka'), accountType: 'cash', ...over }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  const pin = async (customerId: string, latitude: string, longitude: string) => {
    await db.insert(schema.customerAddresses).values({ customerId, label: 'Shop', recipientName: 'Owner', recipientPhone: '0711000000', street: 'Main', city: 'Kiambu', countyOrState: 'Kiambu', country: 'Kenya', latitude, longitude, isDefault: true });
  };
  const setPosition = async (position: 'record' | 'require', nearMetres = 200) => {
    const now = await c.vanSalesSettings.screen(companyId);
    await c.vanSalesSettings.save(companyId, actor, { ...VAN_SALES_DEFAULTS, ...now.settings, vanSell: true, preSell: true, position, nearMetres }, now.version, reason);
  };
  const setOffRoute = async (offRoute: 'allow' | 'refuse') => {
    const now = await c.vanSalesSettings.screen(companyId);
    await c.vanSalesSettings.save(companyId, actor, { ...VAN_SALES_DEFAULTS, ...now.settings, vanSell: true, preSell: true, offRoute }, now.version, reason);
  };
  /** A day with a van, its load signed for, and two customers (one with a map pin). */
  const loadedDay = async (over: { mode?: string } = {}) => {
    const mode = over.mode ?? 'van_sell';
    const user = await person();
    const rep = await c.salesReps.create(companyId, actor, { userId: user.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: { maxDiscountPercent: 0, maxCreditPerDay: 0, mayOverridePrice: false, maySellOnCredit: false } });
    const van = mode === 'pre_sell' ? null : await c.vans.create(companyId, actor, { name: name('RVan'), branchId, vehicleId: null, cashAccountId: null, maxCash: null });
    const route = await c.salesRoutes.create(companyId, actor, { code: `R${tag}${String(next())}`.toUpperCase(), name: name('RRoute'), branchId, mode, defaultVanId: van?.id ?? null, defaultRepId: rep.id });
    const [a, b] = [await customer(), await customer()];
    for (const x of [a, b]) await c.salesRoutes.addStop(companyId, actor, route.id, { customerId: x.id, visitDays: maskOf([0]), every: 1, anchor: monday, note: '' });
    const p = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: p, sku: `RN-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `RNS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: name('Crate'), slug: `rn-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50' });
    await db.transaction(async (tx) => await c.stockLedger.post(tx, { companyId, productId: p, locationId: warehouse, type: 'receipt', quantity: 100, unitCost: 50, actor: { type: 'user', id: 'seed' }, note: 'seed' }));
    if (mode !== 'pre_sell') await c.salesRoutes.setPar(companyId, actor, route.id, [{ productId: p, quantity: 20 }], (await c.salesRoutes.get(companyId, route.id)).version);
    const day = (await c.vanDays.plan(companyId, actor, { routeId: route.id, date: monday })).day;
    return { user, rep, van, route, a, b, p, day };
  };
  const signed = async (s: Awaited<ReturnType<typeof loadedDay>>) => {
    const made = (await c.vanLoads.create(companyId, actor, s.day.id, { kind: 'load', fromLocationId: warehouse, lines: [{ productId: s.p, quantity: 20 }] })).at(-1);
    await c.vanLoads.ship(companyId, actor, made?.id ?? '');
    await c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, { maySell: true, mayPlan: false });
  };
  const version = async (dayId: string) => (await c.vanDays.find(companyId, dayId))?.day.version;
  /** A day that is out, with its shift. */
  const outDay = async (over: { mode?: string; float?: number } = {}) => {
    const s = await loadedDay(over);
    if (s.van !== null) await signed(s);
    const detail = await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: over.float ?? 1000, expectedVersion: await version(s.day.id) }, true);
    return { ...s, detail };
  };
  const visits = async (dayId: string) => (await c.vanDays.find(companyId, dayId))?.visits ?? [];
  const refusedBy = async (p: Promise<unknown>) => {
    const e = (await p.then(() => null, (err: unknown) => err)) as { message?: string; cause?: { message?: string } } | null;
    return e === null ? null : `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    release = await holdLedgerSwitch(url);
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    itemTypeId = `it_rn_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const [branch] = await db.insert(schema.branches).values({ companyId, name: name('Run branch'), code: `RB${tag}${String(next())}`.toUpperCase().slice(0, 10) } as never).returning();
    branchId = branch?.id ?? '';
    warehouse = (await c.stockLocations.create(companyId, { code: `RW${tag}`.toUpperCase(), name: `Run warehouse ${tag}`, kind: 'warehouse', branchId })).id;
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    await setPosition('record');
    await setOffRoute('allow');
  }, 120_000);

  afterAll(async () => {
    await db.update(schema.vanDays).set({ status: 'cancelled', statusReason: 'Cleared after a test run' }).where(sql`${schema.vanDays.status} IN ('planned','loading','out','returning','reconciling')`);
    await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared after a test run' }).where(eq(schema.salesRoutes.status, 'active'));
    await db.update(schema.shifts).set({ status: 'closed', closedAt: new Date(), closedBy: 'test', declaredCash: '0', zNumber: `Z-RN-${tag}` }).where(sql`${schema.shifts.status} IN ('open','closing') AND ${schema.shifts.openedBy} IN (SELECT id::text FROM users WHERE email LIKE '%@run.test')`).catch(() => undefined);
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
    await release();
  }, 120_000);

  describe('sending the day out', () => {
    it('opens the van\'s till with the counted float, ties the shift to the day, and writes its history', async () => {
      const s = await loadedDay();
      await signed(s);
      const out = await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 2500, expectedVersion: await version(s.day.id) }, true);
      expect(out.day).toMatchObject({ status: 'out', statusWords: 'Out on the route' });
      const [row] = await db.select().from(schema.vanDays).where(eq(schema.vanDays.id, s.day.id));
      expect(row?.shiftId).not.toBeNull();
      const [shift] = await db.select().from(schema.shifts).where(eq(schema.shifts.id, row?.shiftId ?? ''));
      expect(shift).toMatchObject({ registerId: s.van?.registerId, openedBy: s.user.id, status: 'open', openingFloat: '2500.00' });
      const last = out.events.at(-1);
      expect(last).toMatchObject({ action: 'day.out', fromStatus: 'loading', toStatus: 'out' });
      expect(out.events.map((e) => e.action)).toEqual(['day.planned', 'day.loading', 'day.load_created', 'day.load_shipped', 'day.load_signed', 'day.out']);
      await expect(c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: out.day.version }, true)).rejects.toThrow('already out');
    });

    it('sends a day that only takes orders straight out, with no van and no till', async () => {
      const s = await loadedDay({ mode: 'pre_sell' });
      const out = await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { expectedVersion: await version(s.day.id) }, true);
      expect(out.day.status).toBe('out');
      expect((await db.select().from(schema.vanDays).where(eq(schema.vanDays.id, s.day.id)))[0]?.shiftId).toBeNull();
    });

    it('is refused in words: before the load is signed for, a float that is not money, a stale screen, a person who is not the rep, one who may not sell, a rep who is paused', async () => {
      const s = await loadedDay();
      await expect(c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: await version(s.day.id) }, true)).rejects.toThrow('has no stock yet');
      await signed(s);
      const v = await version(s.day.id);
      await expect(c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: -5, expectedVersion: v }, true)).rejects.toThrow('cash counted into the van');
      await expect(c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 'lots', expectedVersion: v }, true)).rejects.toThrow('cash counted into the van');
      await expect(c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: (v ?? 0) - 1 }, true)).rejects.toThrow('Someone else changed this day');
      await expect(c.vanRun.sendOut(companyId, actor, s.day.id, { float: 0, expectedVersion: v }, true)).rejects.toThrow(`Only ${s.rep.name} runs their own day`);
      await expect(c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: v }, false)).rejects.toThrow('not allowed to sell');
      // A rep who is paused cannot run a day (the service will not pause one with a day open, so the state is set directly).
      await db.update(schema.salesReps).set({ status: 'paused', statusReason: 'On leave' }).where(eq(schema.salesReps.id, s.rep.id));
      await expect(c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: v }, true)).rejects.toThrow('not selling at the moment');
      await db.update(schema.salesReps).set({ status: 'active', statusReason: null }).where(eq(schema.salesReps.id, s.rep.id));
      expect((await c.vanDays.find(companyId, s.day.id))?.day.status).toBe('loading');
    });

    it('uses a shift the rep already opened on the van\'s till for this day, and never opens a second', async () => {
      const s = await loadedDay();
      await signed(s);
      const count = parseCount({ total: 750 }, 'cash');
      if (!count.ok) throw new Error(count.error);
      const opened = await c.shifts.open(companyId, { userId: s.user.id, branchId: null }, { registerId: s.van?.registerId ?? '', float: count });
      if (!opened.ok) throw new Error(opened.error);
      const out = await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 9999, expectedVersion: await version(s.day.id) }, true);
      expect(out.day.status).toBe('out');
      const [row] = await db.select().from(schema.vanDays).where(eq(schema.vanDays.id, s.day.id));
      expect(row?.shiftId).toBe(opened.shiftId);
      expect(out.events.at(-1)?.reason).toBeNull();
      const shiftsOnRegister = await db.select().from(schema.shifts).where(eq(schema.shifts.registerId, s.van?.registerId ?? ''));
      expect(shiftsOnRegister).toHaveLength(1);
      expect(shiftsOnRegister[0]?.openingFloat).toBe('750.00');
    });

    it('is refused when the till already has another person\'s shift, or the rep has a shift open elsewhere', async () => {
      const a = await loadedDay();
      await signed(a);
      const other = await person();
      const count = parseCount({ total: 0 }, 'cash');
      if (!count.ok) throw new Error(count.error);
      await c.shifts.open(companyId, { userId: other.id, branchId: null }, { registerId: a.van?.registerId ?? '', float: count });
      await expect(c.vanRun.sendOut(companyId, as(a.user), a.day.id, { float: 0, expectedVersion: await version(a.day.id) }, true)).rejects.toThrow('already has a shift open on that till');
      expect((await c.vanDays.find(companyId, a.day.id))?.day.status).toBe('loading');

      const b = await loadedDay();
      await signed(b);
      const second = await c.vans.create(companyId, actor, { name: name('RVan'), branchId, vehicleId: null, cashAccountId: null, maxCash: null });
      await c.shifts.open(companyId, { userId: b.user.id, branchId: null }, { registerId: second.registerId, float: count });
      await expect(c.vanRun.sendOut(companyId, as(b.user), b.day.id, { float: 0, expectedVersion: await version(b.day.id) }, true)).rejects.toThrow('already have a shift open');
    });
  });

  describe('the visits', () => {
    it('are made only while the day is out, and only by its rep', async () => {
      const s = await loadedDay();
      await signed(s);
      const [v1] = await visits(s.day.id);
      await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', {}, true)).rejects.toThrow('while the day is out on the route');
      await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: await version(s.day.id) }, true);
      await expect(c.vanRun.arrive(companyId, actor, s.day.id, v1?.id ?? '', {}, true)).rejects.toThrow('runs their own day');
      await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, 'x', {}, true)).rejects.toThrow('visit could not be found');
      await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, randomUUID(), {}, true)).rejects.toThrow('visit could not be found on this day');
    });

    it('record the arrival with the time, the position and how far it is from the customer\'s pin; never stop a visit when the company only records it', async () => {
      const s = await outDay();
      await pin(s.a.id, '-1.290000', '36.820000');
      const [v1] = await visits(s.day.id);
      const after = await c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', { position: { latitude: -1.2905, longitude: 36.8205 }, deviceTime: '2026-11-30T08:15:00Z' }, true);
      const visit = after.visits[0];
      expect(visit).toMatchObject({ status: 'arrived' });
      expect(visit?.distanceM).toBeGreaterThan(50);
      expect(visit?.distanceM).toBeLessThan(120);
      expect(visit?.arrivedAt).not.toBeNull();
      const [row] = await db.select().from(schema.vanVisits).where(eq(schema.vanVisits.id, v1?.id ?? ''));
      expect(row).toMatchObject({ arrivedLatitude: '-1.290500', arrivedLongitude: '36.820500' });
      expect(row?.deviceArrivedAt?.toISOString()).toBe('2026-11-30T08:15:00.000Z');
      expect(after.events.at(-1)).toMatchObject({ action: 'visit.arrived', words: 'The rep arrived at a customer' });
      await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', {}, true)).rejects.toThrow('already at');
      // A customer with no pin has no distance; no position is recorded as none.
      const second = await c.vanRun.finish(companyId, as(s.user), s.day.id, v1?.id ?? '', { outcome: 'no_sale', reason: 'Has enough stock' }, true);
      const [v2] = second.visits.filter((v) => v.status === 'planned');
      const far = await c.vanRun.arrive(companyId, as(s.user), s.day.id, v2?.id ?? '', { position: { latitude: -1.5, longitude: 36.9 } }, true);
      expect(far.visits.find((v) => v.id === v2?.id)).toMatchObject({ status: 'arrived', distanceM: null });
    });

    it('can be made to require the rep to be near the customer, and say how far they are', async () => {
      const s = await outDay();
      await pin(s.a.id, '-1.290000', '36.820000');
      const [v1] = await visits(s.day.id);
      await setPosition('require', 150);
      try {
        await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', {}, true)).rejects.toThrow('needs your position');
        await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', { position: { latitude: -1.2950, longitude: 36.8200 } }, true)).rejects.toThrow(/You are \d+ m from .*\. Get within 150 m/);
        await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', { position: { latitude: 95, longitude: 0 } }, true)).rejects.toThrow('latitude');
        expect((await visits(s.day.id))[0]?.status).toBe('planned');
        const near = await c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', { position: { latitude: -1.2901, longitude: 36.8201 } }, true);
        expect(near.visits[0]).toMatchObject({ status: 'arrived' });
      } finally {
        await setPosition('record');
      }
    });

    it('allow one visit at a time: the next starts when the one under way is finished', async () => {
      const s = await outDay();
      const [v1, v2] = await visits(s.day.id);
      await c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', {}, true);
      await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, v2?.id ?? '', {}, true)).rejects.toThrow(`Finish the visit at ${v1?.customerName ?? ''} before starting another`);
      await expect(c.vanRun.finish(companyId, as(s.user), s.day.id, v2?.id ?? '', { outcome: 'no_sale', reason: 'Not here' }, true)).rejects.toThrow('Arrive at');
      await expect(c.vanRun.finish(companyId, as(s.user), s.day.id, v1?.id ?? '', { outcome: 'no_sale' }, true)).rejects.toThrow('needs a reason');
      await expect(c.vanRun.finish(companyId, as(s.user), s.day.id, v1?.id ?? '', { outcome: 'won', reason: 'whatever the reason' }, true)).rejects.toThrow('how the visit ended');
      await expect(c.vanRun.finish(companyId, as(s.user), s.day.id, v1?.id ?? '', { outcome: 'sold' }, true)).rejects.toThrow('Nothing has been sold or ordered at');
      const done = await c.vanRun.finish(companyId, as(s.user), s.day.id, v1?.id ?? '', { outcome: 'no_sale', reason: 'Has enough stock for the week' }, true);
      expect(done.visits[0]).toMatchObject({ status: 'done', outcome: 'no_sale', noSaleReason: 'Has enough stock for the week' });
      expect(done.visits[0]?.departedAt).not.toBeNull();
      expect(done.events.at(-1)).toMatchObject({ action: 'visit.done', reason: 'Has enough stock for the week' });
      await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', {}, true)).rejects.toThrow('already finished');
      await c.vanRun.arrive(companyId, as(s.user), s.day.id, v2?.id ?? '', {}, true);
    });

    it('can be skipped with a reason, or found shut (whether or not the rep had arrived), and then cannot be started', async () => {
      const s = await outDay();
      const [v1, v2] = await visits(s.day.id);
      await expect(c.vanRun.skip(companyId, as(s.user), s.day.id, v1?.id ?? '', '', true)).rejects.toThrow('Say why');
      const skipped = await c.vanRun.skip(companyId, as(s.user), s.day.id, v1?.id ?? '', 'The road is flooded', true);
      expect(skipped.visits[0]).toMatchObject({ status: 'skipped', noSaleReason: 'The road is flooded' });
      expect(skipped.events.at(-1)).toMatchObject({ action: 'visit.skipped', reason: 'The road is flooded' });
      await expect(c.vanRun.skip(companyId, as(s.user), s.day.id, v1?.id ?? '', 'Again please', true)).rejects.toThrow('cannot be skipped');
      await expect(c.vanRun.arrive(companyId, as(s.user), s.day.id, v1?.id ?? '', {}, true)).rejects.toThrow('already skipped');
      await c.vanRun.arrive(companyId, as(s.user), s.day.id, v2?.id ?? '', {}, true);
      const shut = await c.vanRun.closedShop(companyId, as(s.user), s.day.id, v2?.id ?? '', undefined, true);
      expect(shut.visits[1]).toMatchObject({ status: 'closed_shop' });
      expect(shut.events.at(-1)).toMatchObject({ action: 'visit.closed_shop', words: 'The shop was found closed' });
      await expect(c.vanRun.closedShop(companyId, as(s.user), s.day.id, v2?.id ?? '', 'x', true)).rejects.toThrow('Say why');
      await expect(c.vanRun.closedShop(companyId, as(s.user), s.day.id, v2?.id ?? '', undefined, true)).rejects.toThrow('already finished');
      // A shop found shut before arriving.
      const t = await outDay();
      const [w1] = await visits(t.day.id);
      expect((await c.vanRun.closedShop(companyId, as(t.user), t.day.id, w1?.id ?? '', 'Padlocked', true)).visits[0]).toMatchObject({ status: 'closed_shop', noSaleReason: 'Padlocked' });
    });

    it('can have a customer added by the rep on the road where the company allows it, and not otherwise', async () => {
      const s = await outDay();
      const extra = await customer();
      const added = await c.vanRun.addOnRoute(companyId, as(s.user), s.day.id, extra.id, true);
      expect(added.visits.at(-1)).toMatchObject({ customerId: extra.id, sequence: 3, fromRoute: false, status: 'planned' });
      expect(added.events.at(-1)).toMatchObject({ action: 'day.visit_added_on_route', words: 'The rep added a customer on the road' });
      await expect(c.vanRun.addOnRoute(companyId, as(s.user), s.day.id, extra.id, true)).rejects.toThrow('already on this day');
      await expect(c.vanRun.addOnRoute(companyId, as(s.user), s.day.id, await c.cashSales.walkIn(companyId), true)).rejects.toThrow('walk-in customer');
      await expect(c.vanRun.addOnRoute(companyId, as(s.user), s.day.id, (await customer({ isActive: false })).id, true)).rejects.toThrow('customer who is in use');
      await expect(c.vanRun.addOnRoute(companyId, actor, s.day.id, (await customer()).id, true)).rejects.toThrow('runs their own day');
      await setOffRoute('refuse');
      try {
        await expect(c.vanRun.addOnRoute(companyId, as(s.user), s.day.id, (await customer()).id, true)).rejects.toThrow('only the customers on the route');
      } finally {
        await setOffRoute('allow');
      }
    });

    it('cannot be arranged by the planner once the day is out', async () => {
      const s = await outDay();
      const [v1] = await visits(s.day.id);
      await expect(c.vanDays.moveVisit(companyId, actor, s.day.id, v1?.id ?? '', 1)).rejects.toThrow('cannot be changed once a day is out on the route');
      await expect(c.vanDays.removeVisit(companyId, actor, s.day.id, v1?.id ?? '')).rejects.toThrow('cannot be changed');
    });
  });

  describe('held by the database itself', () => {
    it('refuses wrong values whichever way they arrive', async () => {
      const s = await outDay();
      const [v1] = await visits(s.day.id);
      const bad = async (set: string) => await refusedBy(db.execute(sql.raw(`UPDATE van_visits SET ${set} WHERE id = '${v1?.id ?? ''}'`)));
      expect(await bad("outcome = 'no_sale'")).toContain('van_visits_no_sale_chk');
      expect(await bad("outcome = 'no_sale', no_sale_reason = '   '")).toContain('van_visits_no_sale_chk');
      expect(await bad('arrived_latitude = -1.29')).toContain('van_visits_position_chk');
      expect(await bad('arrived_distance_m = -5')).toContain('van_visits_distance_chk');
      expect(await bad("outcome = 'won'")).toContain('van_visits_outcome_chk');
    });
  });
});
