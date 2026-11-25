import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { VAN_SALES_DEFAULTS } from '@/lib/van-sales/settings';
import { dayNumber, maskOf, weekdayIndex } from '@/lib/van-sales/visits';

/**
 * Van days (database): a day is planned from a route and a date with the customers due that day as its visits; it holds its rep, van and
 * route for the date; its visits are arranged only while it is got ready; it is cancelled with a reason only before it goes out; a route, van
 * or rep with a day that is not finished cannot be stopped, paused or ended; its history is append-only; and the database refuses wrong
 * values on its own.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

const addDays = (date: string, n: number): string => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
/** A Monday at least a week ahead, so a day can be planned on it whatever today is. */
const firstMonday = (): string => {
  let d = addDays(businessDate(), 7);
  while (weekdayIndex(dayNumber(d) ?? 0) !== 0) d = addDays(d, 1);
  return d;
};

describe.skipIf(url === undefined || url === '')('van days (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let branchId: string;
  let otherBranchId: string;
  const actor: Actor = { type: 'user', id: 'day-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const tag = randomUUID().slice(0, 6);
  let seq = 0;
  const next = () => ++seq;
  const name = (base: string) => `${base} ${tag}${String(next())}`;
  const MON = 0;
  const WED = 2;
  const monday = firstMonday();

  const van = async (over: Record<string, unknown> = {}) => await c.vans.create(companyId, actor, { name: name('DVan'), branchId, vehicleId: null, cashAccountId: null, maxCash: null, ...over });
  const rep = async (modes: string[] = ['van_sell', 'pre_sell']) => {
    const [u] = await db.insert(schema.users).values({ email: `dy-${randomUUID().slice(0, 8)}@day.test`, passwordHash: 'x', name: name('DRep'), role: 'super_admin' }).returning();
    return await c.salesReps.create(companyId, actor, { userId: u?.id ?? '', phone: '', homeBranchId: null, modes, limits: { maxDiscountPercent: 0, maxCreditPerDay: 0, mayOverridePrice: false, maySellOnCredit: false } });
  };
  const customer = async (over: Partial<typeof schemaModule.customers.$inferInsert> = {}) => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `DY${tag}${String(next())}`.toUpperCase(), name: name('Duka'), accountType: 'cash', ...over }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  /** A route with a usual van and rep and three customers: A every Monday, B every second Monday from this one, C on Wednesdays. */
  const setup = async (over: { mode?: string; withVan?: boolean; withRep?: boolean } = {}) => {
    const v = over.withVan === false ? null : await van();
    const r = over.withRep === false ? null : await rep();
    const mode = over.mode ?? 'both';
    const made = await c.salesRoutes.create(companyId, actor, { code: `D${tag}${String(next())}`.toUpperCase(), name: name('DRoute'), branchId, mode, defaultVanId: mode === 'pre_sell' ? null : (v?.id ?? null), defaultRepId: r?.id ?? null });
    const [a, b, w] = await Promise.all([customer(), customer(), customer()]);
    const stop = (customerId: string, days: number[], every: number) => ({ customerId, visitDays: maskOf(days), every, anchor: monday, note: '' });
    await c.salesRoutes.addStop(companyId, actor, made.id, stop(a.id, [MON], 1));
    await c.salesRoutes.addStop(companyId, actor, made.id, stop(b.id, [MON], 2));
    await c.salesRoutes.addStop(companyId, actor, made.id, stop(w.id, [WED], 1));
    return { route: made, van: v, rep: r, a, b, w };
  };
  const refusedBy = async (p: Promise<unknown>) => {
    const e = (await p.then(() => null, (err: unknown) => err)) as { message?: string; cause?: { message?: string } } | null;
    return e === null ? null : `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  };

  beforeAll(async () => {
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await c.reasonCodes.ensureSystemReasons(companyId);
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Day Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const [other] = await db.insert(schema.branches).values({ companyId, name: name('Other branch'), code: `DB${tag}${String(next())}`.toUpperCase().slice(0, 10) } as never).returning();
    otherBranchId = other?.id ?? '';
    const now = await c.vanSalesSettings.screen(companyId);
    await c.vanSalesSettings.save(companyId, actor, { ...VAN_SALES_DEFAULTS, ...now.settings, vanSell: true, preSell: true }, now.version, reason);
  });

  afterAll(async () => {
    // Days and routes left open would stop another run from switching a mode off or stopping a van.
    await db.update(schema.vanDays).set({ status: 'cancelled', statusReason: 'Cleared after a test run' }).where(sql`${schema.vanDays.status} IN ('planned','loading','out','returning','reconciling')`);
    await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared after a test run' }).where(eq(schema.salesRoutes.status, 'active'));
  });

  describe('planning', () => {
    it('makes a day from a route and a date with the customers due that day as its visits, in the order of the round, and writes its first history entry', async () => {
      const s = await setup();
      const planned = await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday });
      expect(planned.day).toMatchObject({ routeId: s.route.id, repId: s.rep?.id, vanId: s.van?.id, date: monday, mode: 'both', status: 'planned', statusReason: null, version: 1, visits: 2, visitsDone: 0, branchId });
      expect(planned.day.number).toMatch(/^VDY-\d{2}-\d{8}$/);
      // A is due every Monday, B is due on the first Monday of its fortnight, C is a Wednesday customer.
      expect(planned.visits.map((v) => [v.customerId, v.sequence, v.status, v.fromRoute])).toEqual([[s.a.id, 1, 'planned', true], [s.b.id, 2, 'planned', true]]);
      expect(planned.events).toHaveLength(1);
      expect(planned.events[0]).toMatchObject({ action: 'day.planned', words: 'The day was planned', toStatus: 'planned', fromStatus: null });
      expect(Date.now() - new Date(planned.events[0]?.at ?? 0).getTime()).toBeLessThan(60_000);
      // The fortnightly customer is off the next Monday; the Wednesday customer is due that Wednesday.
      const nextWeek = await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: addDays(monday, 7) });
      expect(nextWeek.visits.map((v) => v.customerId)).toEqual([s.a.id]);
      const wednesday = await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: addDays(monday, 2) });
      expect(wednesday.visits.map((v) => v.customerId)).toEqual([s.w.id]);
    });

    it('uses the rep and van chosen for the day instead of the route\'s usual ones', async () => {
      const s = await setup();
      const otherRep = await rep();
      const otherVan = await van();
      const planned = await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday, repId: otherRep.id, vanId: otherVan.id });
      expect(planned.day).toMatchObject({ repId: otherRep.id, repName: otherRep.name, vanId: otherVan.id, vanName: otherVan.name });
    });

    it('plans a pre-sell day with no van and no cash', async () => {
      const s = await setup({ mode: 'pre_sell', withVan: false });
      const planned = await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday });
      expect(planned.day).toMatchObject({ mode: 'pre_sell', vanId: null, vanName: null });
      await expect(c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: addDays(monday, 7), vanId: (await van()).id })).rejects.toThrow('has no van');
    });

    it('is refused in words: a date gone by, a route that is stopped or has nobody due, a rep or van that does not fit', async () => {
      const s = await setup();
      await expect(c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: addDays(businessDate(), -1) })).rejects.toThrow('has passed');
      await expect(c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: '2026-02-30' })).rejects.toThrow('real date');
      await expect(c.vanDays.plan(companyId, actor, { routeId: randomUUID(), date: monday })).rejects.toThrow('route could not be found');
      await expect(c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: addDays(monday, 1) })).rejects.toThrow('No customer on this route is due');
      const noDefaults = await setup({ withVan: false, withRep: false });
      await expect(c.vanDays.plan(companyId, actor, { routeId: noDefaults.route.id, date: monday })).rejects.toThrow('no usual rep');
      await expect(c.vanDays.plan(companyId, actor, { routeId: noDefaults.route.id, date: monday, repId: (await rep()).id })).rejects.toThrow('no usual van');
      await expect(c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: addDays(monday, 14), repId: (await rep(['pre_sell'])).id })).rejects.toThrow('does not do van sell');
      const paused = await rep();
      await c.salesReps.setStatus(companyId, actor, paused.id, { status: 'paused', reason: 'On leave', expectedVersion: paused.version });
      await expect(c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: addDays(monday, 14), repId: paused.id })).rejects.toThrow('who is selling');
      const stoppedVan = await van();
      await c.vans.setActive(companyId, actor, stoppedVan.id, { active: false, reason: 'In the garage', expectedVersion: stoppedVan.version });
      await expect(c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: addDays(monday, 14), vanId: stoppedVan.id })).rejects.toThrow('van that is in use');
      const other = await c.vans.create(companyId, actor, { name: name('FarVan'), branchId: otherBranchId, vehicleId: null, cashAccountId: null, maxCash: null });
      await expect(c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: addDays(monday, 14), vanId: other.id })).rejects.toThrow('another branch');
      const stoppedRoute = await c.salesRoutes.get(companyId, s.route.id);
      await c.salesRoutes.setActive(companyId, actor, s.route.id, { active: false, reason: 'Seasonal route', expectedVersion: stoppedRoute.version });
      await expect(c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday })).rejects.toThrow('route is stopped');
      expect((await c.vanDays.page(companyId, { query: s.route.name, status: 'all' })).rows).toHaveLength(0);
    });

    it('holds the rep, the van and the route for the date, and gives them back when the day is cancelled', async () => {
      const a = await setup();
      const b = await setup();
      const first = await c.vanDays.plan(companyId, actor, { routeId: a.route.id, date: monday });
      await expect(c.vanDays.plan(companyId, actor, { routeId: a.route.id, date: monday, repId: b.rep?.id, vanId: b.van?.id })).rejects.toThrow(`This route already has a day on that date (${first.day.number})`);
      await expect(c.vanDays.plan(companyId, actor, { routeId: b.route.id, date: monday, repId: a.rep?.id })).rejects.toThrow(new RegExp(`Sales rep ${a.rep?.name ?? ''} already has a day on that date \\(${first.day.number}\\)`));
      await expect(c.vanDays.plan(companyId, actor, { routeId: b.route.id, date: monday, vanId: a.van?.id })).rejects.toThrow(new RegExp(`The van ${a.van?.name ?? ''} already has a day on that date \\(${first.day.number}\\)`));
      // Another date is free.
      await c.vanDays.plan(companyId, actor, { routeId: b.route.id, date: monday, repId: b.rep?.id, vanId: b.van?.id });
      const cancelled = await c.vanDays.cancel(companyId, actor, first.day.id, { reason: 'The customers are closed', expectedVersion: first.day.version });
      expect(cancelled.day.status).toBe('cancelled');
      const again = await c.vanDays.plan(companyId, actor, { routeId: a.route.id, date: monday });
      expect(again.day.id).not.toBe(first.day.id);
      expect(again.day.number).not.toBe(first.day.number);
    });
  });

  describe('the visits', () => {
    it('are arranged while the day is got ready: a customer added at the end, moved up or down, taken off with the rest closing up', async () => {
      const s = await setup();
      const day = (await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday })).day;
      const extra = await customer();
      let detail = await c.vanDays.addVisit(companyId, actor, day.id, extra.id);
      expect(detail.visits.map((v) => [v.customerId, v.sequence, v.fromRoute])).toEqual([[s.a.id, 1, true], [s.b.id, 2, true], [extra.id, 3, false]]);
      await expect(c.vanDays.addVisit(companyId, actor, day.id, extra.id)).rejects.toThrow('already on this day');
      await expect(c.vanDays.addVisit(companyId, actor, day.id, await c.cashSales.walkIn(companyId))).rejects.toThrow('walk-in customer');
      await expect(c.vanDays.addVisit(companyId, actor, day.id, (await customer({ isActive: false })).id)).rejects.toThrow('customer who is in use');
      await expect(c.vanDays.addVisit(companyId, actor, day.id, 'x')).rejects.toThrow('from the list');

      const [v1, v2, v3] = detail.visits;
      if (v1 === undefined || v2 === undefined || v3 === undefined) throw new Error('visits');
      detail = await c.vanDays.moveVisit(companyId, actor, day.id, v3.id, -1);
      expect(detail.visits.map((v) => v.id)).toEqual([v1.id, v3.id, v2.id]);
      await expect(c.vanDays.moveVisit(companyId, actor, day.id, v1.id, -1)).rejects.toThrow('already first');
      await expect(c.vanDays.moveVisit(companyId, actor, day.id, v2.id, 1)).rejects.toThrow('already last');
      await expect(c.vanDays.moveVisit(companyId, actor, day.id, v2.id, 3)).rejects.toThrow('up or down one place');
      await expect(c.vanDays.moveVisit(companyId, actor, day.id, randomUUID(), 1)).rejects.toThrow('no longer on this day');

      detail = await c.vanDays.removeVisit(companyId, actor, day.id, v3.id);
      expect(detail.visits.map((v) => [v.id, v.sequence])).toEqual([[v1.id, 1], [v2.id, 2]]);
      await expect(c.vanDays.removeVisit(companyId, actor, day.id, v3.id)).rejects.toThrow('no longer on this day');
      expect(detail.day.version).toBeGreaterThan(day.version);
      expect(detail.events.map((e) => e.action)).toEqual(['day.planned', 'day.visit_added', 'day.visits_ordered', 'day.visit_removed']);
    });

    it('cannot be changed once the day is out, or when a visit has already started', async () => {
      const s = await setup();
      const day = (await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday })).day;
      const detail = (await c.vanDays.find(companyId, day.id))?.visits ?? [];
      const first = detail[0];
      await db.update(schema.vanVisits).set({ status: 'arrived' }).where(eq(schema.vanVisits.id, first?.id ?? ''));
      await expect(c.vanDays.removeVisit(companyId, actor, day.id, first?.id ?? '')).rejects.toThrow('already started');
      await db.update(schema.vanDays).set({ status: 'out' }).where(eq(schema.vanDays.id, day.id));
      await expect(c.vanDays.addVisit(companyId, actor, day.id, (await customer()).id)).rejects.toThrow('cannot be changed once a day is out on the route');
      await expect(c.vanDays.moveVisit(companyId, actor, day.id, first?.id ?? '', 1)).rejects.toThrow('cannot be changed');
      await expect(c.vanDays.removeVisit(companyId, actor, day.id, first?.id ?? '')).rejects.toThrow('cannot be changed');
    });
  });

  describe('cancelling', () => {
    it('needs a reason and the version on screen, works only before the day goes out, and is written to the history', async () => {
      const s = await setup();
      const day = (await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday })).day;
      await expect(c.vanDays.cancel(companyId, actor, day.id, { reason: '', expectedVersion: day.version })).rejects.toThrow('Say why');
      await expect(c.vanDays.cancel(companyId, actor, day.id, { reason: 'Customers closed', expectedVersion: day.version - 1 })).rejects.toThrow('Someone else changed this day');
      const done = await c.vanDays.cancel(companyId, actor, day.id, { reason: 'Customers closed', expectedVersion: day.version });
      expect(done.day).toMatchObject({ status: 'cancelled', statusReason: 'Customers closed', version: day.version + 1 });
      expect(done.events.at(-1)).toMatchObject({ action: 'day.cancelled', fromStatus: 'planned', toStatus: 'cancelled', reason: 'Customers closed' });
      await expect(c.vanDays.cancel(companyId, actor, day.id, { reason: 'Again please', expectedVersion: done.day.version })).rejects.toThrow('already cancelled');
      await expect(c.vanDays.addVisit(companyId, actor, day.id, (await customer()).id)).rejects.toThrow('cannot be changed once a day is cancelled');

      const out = await setup();
      const outDay = (await c.vanDays.plan(companyId, actor, { routeId: out.route.id, date: monday })).day;
      await db.update(schema.vanDays).set({ status: 'out' }).where(eq(schema.vanDays.id, outDay.id));
      await expect(c.vanDays.cancel(companyId, actor, outDay.id, { reason: 'Changed my mind', expectedVersion: outDay.version })).rejects.toThrow('cannot be cancelled');
    });
  });

  describe('a day that is not finished', () => {
    it('keeps its route, van and rep from being stopped, paused or ended, and says which day it is', async () => {
      const s = await setup();
      const day = (await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday })).day;
      const route = await c.salesRoutes.get(companyId, s.route.id);
      await expect(c.salesRoutes.setActive(companyId, actor, route.id, { active: false, reason: 'Seasonal route', expectedVersion: route.version })).rejects.toThrow(`has a day that is not finished: ${day.number} on ${monday}`);
      await expect(c.vans.setActive(companyId, actor, s.van?.id ?? '', { active: false, reason: 'In the garage', expectedVersion: s.van?.version })).rejects.toThrow(day.number);
      await expect(c.salesReps.setStatus(companyId, actor, s.rep?.id ?? '', { status: 'paused', reason: 'On leave', expectedVersion: s.rep?.version })).rejects.toThrow(day.number);
      await expect(c.salesReps.setStatus(companyId, actor, s.rep?.id ?? '', { status: 'ended', reason: 'Left the company', expectedVersion: s.rep?.version })).rejects.toThrow('not finished');
      // Once the day is cancelled they are free.
      await c.vanDays.cancel(companyId, actor, day.id, { reason: 'Customers closed', expectedVersion: day.version });
      expect((await c.salesReps.setStatus(companyId, actor, s.rep?.id ?? '', { status: 'paused', reason: 'On leave', expectedVersion: s.rep?.version })).status).toBe('paused');
      const stopped = await c.salesRoutes.setActive(companyId, actor, route.id, { active: false, reason: 'Seasonal route', expectedVersion: route.version });
      expect(stopped.status).toBe('stopped');
    });

    it('is also open while it is being loaded, out, back or counted, but not once it is closed', async () => {
      for (const status of ['loading', 'out', 'returning', 'reconciling'] as const) {
        const s = await setup();
        const day = (await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday })).day;
        await db.update(schema.vanDays).set({ status }).where(eq(schema.vanDays.id, day.id));
        await expect(c.vans.setActive(companyId, actor, s.van?.id ?? '', { active: false, reason: 'In the garage', expectedVersion: s.van?.version }), status).rejects.toThrow('not finished');
      }
      // A van that is no route's usual van, used for one day only: once that day is closed it can be stopped.
      const s = await setup();
      const lent = await van();
      const day = (await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday, vanId: lent.id })).day;
      await expect(c.vans.setActive(companyId, actor, lent.id, { active: false, reason: 'In the garage', expectedVersion: lent.version })).rejects.toThrow('not finished');
      await db.update(schema.vanDays).set({ status: 'closed' }).where(eq(schema.vanDays.id, day.id));
      expect((await c.vans.setActive(companyId, actor, lent.id, { active: false, reason: 'In the garage', expectedVersion: lent.version })).status).toBe('stopped');
    });
  });

  describe('the history', () => {
    it('is in order with the server\'s time, who did it and why, and can never be changed or deleted', async () => {
      const s = await setup();
      const day = (await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday })).day;
      await c.vanDays.addVisit(companyId, actor, day.id, (await customer()).id);
      await c.vanDays.cancel(companyId, actor, day.id, { reason: 'Customers closed', expectedVersion: (await c.vanDays.find(companyId, day.id))?.day.version });
      const events = (await c.vanDays.find(companyId, day.id))?.events ?? [];
      expect(events.map((e) => e.action)).toEqual(['day.planned', 'day.visit_added', 'day.cancelled']);
      const times = events.map((e) => new Date(e.at).getTime());
      expect([...times].sort((a, b) => a - b)).toEqual(times);
      const rows = await db.select().from(schema.vanDayEvents).where(eq(schema.vanDayEvents.dayId, day.id));
      expect(rows.every((r) => r.actorId === actor.id && r.actorType === 'user')).toBe(true);
      expect(await refusedBy(db.update(schema.vanDayEvents).set({ reason: 'Rewritten' }).where(eq(schema.vanDayEvents.dayId, day.id)))).toContain('never changed or deleted');
      expect(await refusedBy(db.delete(schema.vanDayEvents).where(eq(schema.vanDayEvents.dayId, day.id)))).toContain('never changed or deleted');
      expect(await db.select().from(schema.vanDayEvents).where(eq(schema.vanDayEvents.dayId, day.id))).toHaveLength(3);
    });
  });

  describe('listing', () => {
    it('pages the days, latest date first, with a search and a filter, and counts them', async () => {
      const s = await setup({ mode: 'van_sell' });
      const weeks = Array.from({ length: 26 }, (_, i) => addDays(monday, 7 * (i + 3)));
      for (const date of weeks) await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date });
      const first = await c.vanDays.page(companyId, { query: s.route.name, status: 'all' });
      expect(first.rows).toHaveLength(25);
      expect(first.nextCursor).not.toBeNull();
      const second = await c.vanDays.page(companyId, { query: s.route.name, status: 'all', cursor: first.nextCursor });
      expect(second.rows).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const dates = [...first.rows, ...second.rows].map((d) => d.date);
      expect(dates).toEqual([...dates].sort().reverse());
      expect(new Set(dates).size).toBe(26);
      expect((await c.vanDays.page(companyId, { query: s.route.name, status: 'cancelled' })).rows).toHaveLength(0);
      expect((await c.vanDays.page(companyId, { query: first.rows[0]?.number ?? '', status: 'open' })).rows.map((d) => d.id)).toEqual([first.rows[0]?.id]);
      const counts = await c.vanDays.counts(companyId);
      expect(counts.open).toBeGreaterThanOrEqual(26);
    });
  });

  describe('held by the database itself', () => {
    it('refuses wrong values whichever way they arrive', async () => {
      const s = await setup();
      const day = (await c.vanDays.plan(companyId, actor, { routeId: s.route.id, date: monday })).day;
      const bad = async (table: string, set: string, where: string) => await refusedBy(db.execute(sql.raw(`UPDATE ${table} SET ${set} WHERE ${where}`)));
      const d = `id = '${day.id}'`;
      expect(await bad('van_days', "status = 'gone'", d)).toContain('van_days_status_chk');
      expect(await bad('van_days', "mode = 'walking'", d)).toContain('van_days_mode_chk');
      expect(await bad('van_days', "status = 'cancelled'", d)).toContain('van_days_cancelled_reason_chk');
      expect(await bad('van_days', 'van_id = NULL', d)).toContain('van_days_van_chk');
      const pre = await setup({ mode: 'pre_sell', withVan: false });
      const preDay = (await c.vanDays.plan(companyId, actor, { routeId: pre.route.id, date: monday })).day;
      expect(await bad('van_days', `van_id = '${s.van?.id ?? ''}'`, `id = '${preDay.id}'`)).toContain('van_days_van_chk');
      const visit = (await c.vanDays.find(companyId, day.id))?.visits[0];
      const v = `id = '${visit?.id ?? ''}'`;
      expect(await bad('van_visits', "status = 'gone'", v)).toContain('van_visits_status_chk');
      expect(await bad('van_visits', "outcome = 'won'", v)).toContain('van_visits_outcome_chk');
      expect(await bad('van_visits', 'sequence = 0', v)).toContain('van_visits_sequence_chk');
      expect(await refusedBy(db.insert(schema.vanVisits).values({ companyId, dayId: day.id, customerId: visit?.customerId ?? '', sequence: 9 }))).toContain('van_visits_day_customer_uidx');
    });
  });
});
