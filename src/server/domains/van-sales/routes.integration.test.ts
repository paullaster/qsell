import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { getContainer } from '@/server/di/container';
import type { drizzleDb } from '@/server/db/drizzle/client';
import type * as schemaModule from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import { VAN_SALES_DEFAULTS } from '@/lib/van-sales/settings';
import { maskOf } from '@/lib/van-sales/visits';

/**
 * Routes (database): a route is a named round of customers for van sell, pre-sell or both; its van and rep must fit it; its stops keep
 * their place in the round even when two people add at once; its usual stock holds each product once with a quantity that fits; a mode
 * cannot be switched off, a van stopped or a rep ended while a route in use needs them; the database refuses wrong values on its own.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (url !== undefined && url !== '') process.env.DATABASE_URL = url;

describe.skipIf(url === undefined || url === '')('routes (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let companyId: string;
  let branchId: string;
  let otherBranchId: string;
  let itemTypeId: string;
  const actor: Actor = { type: 'user', id: 'route-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const tag = randomUUID().slice(0, 6);
  let seq = 0;
  const next = () => ++seq;
  const name = (base: string) => `${base} ${tag}${String(next())}`;
  const code = () => `R${tag}${String(next())}`.toUpperCase();
  const MON = 0;
  const WED = 2;

  const setModes = async (vanSell: boolean, preSell: boolean) => {
    const now = await c.vanSalesSettings.screen(companyId);
    await c.vanSalesSettings.save(companyId, actor, { ...VAN_SALES_DEFAULTS, ...now.settings, vanSell, preSell }, now.version, reason);
  };
  const van = async (over: Record<string, unknown> = {}) => await c.vans.create(companyId, actor, { name: name('RVan'), branchId, vehicleId: null, cashAccountId: null, maxCash: null, ...over });
  const person = async () => {
    const [u] = await db.insert(schema.users).values({ email: `rt-${randomUUID().slice(0, 8)}@route.test`, passwordHash: 'x', name: name('RRep'), role: 'super_admin' }).returning();
    if (u === undefined) throw new Error('no user');
    return u;
  };
  const rep = async (modes: string[] = ['van_sell', 'pre_sell']) => await c.salesReps.create(companyId, actor, { userId: (await person()).id, phone: '', homeBranchId: null, modes, limits: { maxDiscountPercent: 0, maxCreditPerDay: 0, mayOverridePrice: false, maySellOnCredit: false } });
  const customer = async (over: Partial<typeof schemaModule.customers.$inferInsert> = {}) => {
    const [row] = await db.insert(schema.customers).values({ companyId, number: `RT${tag}${String(next())}`.toUpperCase(), name: name('Shop'), accountType: 'cash', ...over }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  const product = async (over: Partial<typeof schemaModule.products.$inferInsert> = {}) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `RT-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `RTS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: name('Crate'), slug: `rt-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50', ...over });
    return id;
  };
  const route = async (over: Record<string, unknown> = {}) => await c.salesRoutes.create(companyId, actor, { code: code(), name: name('Route'), branchId, mode: 'both', defaultVanId: null, defaultRepId: null, ...over });
  const stop = (customerId: string, over: Record<string, unknown> = {}) => ({ customerId, visitDays: maskOf([MON]), every: 1, anchor: '2026-11-02', note: '', ...over });
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
    itemTypeId = `it_rt_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Route Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const [other] = await db.insert(schema.branches).values({ companyId, name: name('Other branch'), code: `RB${tag}${String(next())}`.toUpperCase().slice(0, 10) } as never).returning();
    otherBranchId = other?.id ?? '';
    // Routes left in use by an earlier run on this database would stop a mode being switched off below.
    await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared before a test run' }).where(eq(schema.salesRoutes.status, 'active'));
    await setModes(true, true);
  });

  afterAll(async () => {
    await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared after a test run' }).where(eq(schema.salesRoutes.status, 'active'));
  });

  describe('routes', () => {
    it('are made with a code, a name, a branch and a mode, and logged', async () => {
      const v = await van();
      const r = await rep();
      const input = { code: ` ${code().toLowerCase()} `, name: name('Kiambu'), branchId, mode: 'both', defaultVanId: v.id, defaultRepId: r.id };
      const made = await c.salesRoutes.create(companyId, actor, input);
      expect(made).toMatchObject({ code: input.code.trim().toUpperCase(), name: input.name, branchId, mode: 'both', defaultVanId: v.id, defaultVanName: v.name, defaultRepId: r.id, defaultRepName: r.name, status: 'active', stops: 0, parLines: 0, version: 1 });
      const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, made.id)).orderBy(schema.decisionLog.occurredAt);
      expect(log.map((l) => l.action)).toEqual(['route.created']);
    });

    it('are refused a code or name already used (whatever the letter case), in words', async () => {
      const first = await route();
      await expect(route({ code: first.code.toLowerCase() })).rejects.toThrow('code already exists');
      await expect(route({ name: first.name.toUpperCase() })).rejects.toThrow('name already exists');
      await expect(route({ code: '' })).rejects.toThrow('short code');
      await expect(route({ name: 'K' })).rejects.toThrow('name of 2 to 60');
      await expect(route({ mode: 'walking' })).rejects.toThrow('van sell, pre-sell, or both');
    });

    it('need a van, rep and branch that fit: a pre-sell route has no van, the van is in the route\'s branch, the rep does what the route needs', async () => {
      const v = await van();
      await expect(route({ mode: 'pre_sell', defaultVanId: v.id })).rejects.toThrow('no usual van');
      await expect(route({ branchId: otherBranchId, defaultVanId: v.id })).rejects.toThrow('belongs to another branch');
      await expect(route({ branchId: randomUUID() })).rejects.toThrow('branches that is in use');
      await expect(route({ defaultVanId: randomUUID() })).rejects.toThrow('vans that is in use');
      const stopped = await van();
      await c.vans.setActive(companyId, actor, stopped.id, { active: false, reason: 'Not needed', expectedVersion: stopped.version });
      await expect(route({ defaultVanId: stopped.id })).rejects.toThrow('vans that is in use');
      const preOnly = await rep(['pre_sell']);
      await expect(route({ mode: 'both', defaultRepId: preOnly.id })).rejects.toThrow('does not do van sell');
      await expect(route({ mode: 'van_sell', defaultRepId: preOnly.id })).rejects.toThrow('does not do van sell');
      expect((await route({ mode: 'pre_sell', defaultRepId: preOnly.id })).defaultRepId).toBe(preOnly.id);
      const paused = await rep();
      await c.salesReps.setStatus(companyId, actor, paused.id, { status: 'paused', reason: 'On leave', expectedVersion: paused.version });
      await expect(route({ defaultRepId: paused.id })).rejects.toThrow('who is selling');
    });

    it('can be in a mode only while the company has that mode switched on, and a mode in use by a route cannot be switched off', async () => {
      // The routes the earlier tests left in use need pre-selling: the guard says so by name, and nothing is switched off.
      await expect(setModes(true, false)).rejects.toThrow(/Pre-selling cannot be switched off while routes in use need it \(/);
      await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared in test' }).where(eq(schema.salesRoutes.status, 'active'));
      await setModes(true, false);
      await expect(route({ mode: 'pre_sell' })).rejects.toThrow('Pre-selling is switched off');
      await expect(route({ mode: 'both' })).rejects.toThrow('Pre-selling is switched off');
      const vanOnly = await route({ mode: 'van_sell' });
      await setModes(true, true);
      const both = await route({ mode: 'both' });
      // Pre-selling is needed by the route that does both.
      await expect(setModes(true, false)).rejects.toThrow(/Pre-selling cannot be switched off while routes in use need it/);
      await c.salesRoutes.setActive(companyId, actor, both.id, { active: false, reason: 'Seasonal', expectedVersion: both.version });
      await c.salesRoutes.setActive(companyId, actor, vanOnly.id, { active: false, reason: 'Seasonal', expectedVersion: vanOnly.version });
      await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared in test' }).where(eq(schema.salesRoutes.status, 'active'));
      await setModes(true, false);
      await expect(route({ mode: 'both' })).rejects.toThrow('Pre-selling is switched off');
      await setModes(true, true);
    });

    it('are changed under a version; the branch stays; a stopped route is not changed', async () => {
      const made = await route();
      const input = { code: made.code, name: name('Renamed'), branchId, mode: 'van_sell', defaultVanId: null, defaultRepId: null };
      const changed = await c.salesRoutes.update(companyId, actor, made.id, input, made.version);
      expect(changed).toMatchObject({ name: input.name, mode: 'van_sell', version: made.version + 1 });
      await expect(c.salesRoutes.update(companyId, actor, made.id, input, made.version)).rejects.toThrow('Someone else changed this route');
      await expect(c.salesRoutes.update(companyId, actor, made.id, { ...input, branchId: otherBranchId }, changed.version)).rejects.toThrow('stays in its branch');
      const stopped = await c.salesRoutes.setActive(companyId, actor, made.id, { active: false, reason: 'Seasonal route', expectedVersion: changed.version });
      expect(stopped).toMatchObject({ status: 'stopped', statusReason: 'Seasonal route' });
      await expect(c.salesRoutes.update(companyId, actor, made.id, input, stopped.version)).rejects.toThrow('stopped');
      await expect(c.salesRoutes.setActive(companyId, actor, made.id, { active: false, reason: 'Again please', expectedVersion: stopped.version })).rejects.toThrow('already stopped');
      await expect(c.salesRoutes.setActive(companyId, actor, made.id, { active: true, expectedVersion: stopped.version - 1 })).rejects.toThrow('Someone else');
      const back = await c.salesRoutes.setActive(companyId, actor, made.id, { active: true, expectedVersion: stopped.version });
      expect(back).toMatchObject({ status: 'active', statusReason: null });
      const actions = (await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, made.id)).orderBy(schema.decisionLog.occurredAt)).map((l) => l.action);
      expect(actions).toEqual(['route.created', 'route.changed', 'route.stopped', 'route.resumed']);
    });

    it('cannot be stopped without a reason, and cannot be put back while its van or rep is no longer in use', async () => {
      const v = await van();
      const r = await rep();
      const made = await route({ defaultVanId: v.id, defaultRepId: r.id });
      await expect(c.salesRoutes.setActive(companyId, actor, made.id, { active: false, reason: '', expectedVersion: made.version })).rejects.toThrow('Say why');
      const stopped = await c.salesRoutes.setActive(companyId, actor, made.id, { active: false, reason: 'Seasonal route', expectedVersion: made.version });
      const vStopped = await c.vans.setActive(companyId, actor, v.id, { active: false, reason: 'Sold the van', expectedVersion: v.version });
      await expect(c.salesRoutes.setActive(companyId, actor, made.id, { active: true, expectedVersion: stopped.version })).rejects.toThrow('vans that is in use');
      await c.vans.setActive(companyId, actor, v.id, { active: true, expectedVersion: vStopped.version });
      expect((await c.salesRoutes.setActive(companyId, actor, made.id, { active: true, expectedVersion: stopped.version })).status).toBe('active');
    });

    it('keep their van and rep in use: a van or rep that a route in use depends on is not stopped or ended', async () => {
      const v = await van();
      const r = await rep();
      const made = await route({ defaultVanId: v.id, defaultRepId: r.id });
      await expect(c.vans.setActive(companyId, actor, v.id, { active: false, reason: 'Sold the van', expectedVersion: v.version })).rejects.toThrow(`usual van of the route ${made.name}`);
      await expect(c.salesReps.setStatus(companyId, actor, r.id, { status: 'ended', reason: 'Left the company', expectedVersion: r.version })).rejects.toThrow(`usual rep of the route ${made.name}`);
      // A pause is allowed: the rep comes back.
      expect((await c.salesReps.setStatus(companyId, actor, r.id, { status: 'paused', reason: 'On leave', expectedVersion: r.version })).status).toBe('paused');
      const stopped = await c.salesRoutes.setActive(companyId, actor, made.id, { active: false, reason: 'Seasonal route', expectedVersion: made.version });
      expect(stopped.status).toBe('stopped');
      expect((await c.vans.setActive(companyId, actor, v.id, { active: false, reason: 'Sold the van', expectedVersion: v.version })).status).toBe('stopped');
    });

    it('are listed a page at a time, by name, with a search and a status filter', async () => {
      const marker = name('Pageroute');
      for (let i = 0; i < 26; i += 1) await route({ code: `P${tag}${String(next())}`.toUpperCase(), name: `${marker} ${String(i).padStart(2, '0')}` });
      const first = await c.salesRoutes.page(companyId, { query: marker, status: 'all' });
      expect(first.rows).toHaveLength(25);
      const second = await c.salesRoutes.page(companyId, { query: marker, status: 'all', cursor: first.nextCursor });
      expect(second.rows).toHaveLength(1);
      expect(second.nextCursor).toBeNull();
      const names = [...first.rows, ...second.rows].map((r) => r.name);
      expect(names).toEqual([...names].sort());
      expect((await c.salesRoutes.page(companyId, { query: marker, status: 'stopped' })).rows).toHaveLength(0);
      expect((await c.salesRoutes.page(companyId, { query: first.rows[0]?.code ?? '', status: 'active' })).rows.length).toBeGreaterThanOrEqual(1);
      expect((await c.salesRoutes.counts(companyId)).active).toBeGreaterThanOrEqual(26);
    });
  });

  describe('stops', () => {
    it('are added at the end of the round, with the days and how often, and show their customer and a warning if they cannot be sold to', async () => {
      const r = await route();
      const a = await customer({ phone: '0711000111', city: 'Kiambu' });
      const b = await customer({ blocked: 'all' });
      const first = await c.salesRoutes.addStop(companyId, actor, r.id, stop(a.id, { visitDays: maskOf([MON, WED]), every: 2, note: ' Gate B ' }));
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ customerId: a.id, customerName: a.name, customerPhone: '0711000111', customerPlace: 'Kiambu', sequence: 1, visitDays: 0b101, every: 2, anchor: '2026-11-02', note: 'Gate B', customerWarning: null, visitWords: 'Mon, Wed, every 2 weeks' });
      const second = await c.salesRoutes.addStop(companyId, actor, r.id, stop(b.id));
      expect(second.map((s) => [s.customerId, s.sequence])).toEqual([[a.id, 1], [b.id, 2]]);
      expect(second[1]?.customerWarning).toBe('This customer is blocked from being sold to.');
      expect((await c.salesRoutes.get(companyId, r.id)).stops).toBe(2);
    });

    it('refuse a customer already on the route, the walk-in customer, one not in use, one that is not the company\'s, and a stopped route', async () => {
      const r = await route();
      const a = await customer();
      await c.salesRoutes.addStop(companyId, actor, r.id, stop(a.id));
      await expect(c.salesRoutes.addStop(companyId, actor, r.id, stop(a.id))).rejects.toThrow('already on this route');
      await expect(c.salesRoutes.addStop(companyId, actor, r.id, stop(await c.cashSales.walkIn(companyId)))).rejects.toThrow('walk-in customer');
      await expect(c.salesRoutes.addStop(companyId, actor, r.id, stop((await customer({ isActive: false })).id))).rejects.toThrow('customer who is in use');
      await expect(c.salesRoutes.addStop(companyId, actor, r.id, stop(randomUUID()))).rejects.toThrow('customer who is in use');
      await expect(c.salesRoutes.addStop(companyId, actor, r.id, stop((await customer()).id, { visitDays: 0 }))).rejects.toThrow('at least one day');
      await expect(c.salesRoutes.addStop(companyId, actor, r.id, stop((await customer()).id, { every: 3 }))).rejects.toThrow('how often');
      await expect(c.salesRoutes.addStop(companyId, actor, r.id, stop((await customer()).id, { anchor: '2026-02-30' }))).rejects.toThrow('date the visits start');
      const made = await c.salesRoutes.get(companyId, r.id);
      await c.salesRoutes.setActive(companyId, actor, r.id, { active: false, reason: 'Seasonal route', expectedVersion: made.version });
      await expect(c.salesRoutes.addStop(companyId, actor, r.id, stop((await customer()).id))).rejects.toThrow('route is stopped');
      expect(await c.salesRoutes.stops(companyId, r.id)).toHaveLength(1);
    });

    it('keep distinct places when several people add at once', async () => {
      const r = await route();
      const people = await Promise.all(Array.from({ length: 6 }, () => customer()));
      await Promise.all(people.map((p) => c.salesRoutes.addStop(companyId, actor, r.id, stop(p.id))));
      const stops = await c.salesRoutes.stops(companyId, r.id);
      expect(stops.map((s) => s.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
      expect(new Set(stops.map((s) => s.customerId)).size).toBe(6);
    });

    it('are changed under a version (the customer stays), taken off with the rest closing up, and put in a new order that must name every stop', async () => {
      const r = await route();
      const cs = await Promise.all([customer(), customer(), customer(), customer()]);
      for (const x of cs) await c.salesRoutes.addStop(companyId, actor, r.id, stop(x.id));
      let stops = await c.salesRoutes.stops(companyId, r.id);
      const [s1, s2, s3, s4] = stops;
      if (s1 === undefined || s2 === undefined || s3 === undefined || s4 === undefined) throw new Error('stops');

      stops = await c.salesRoutes.updateStop(companyId, actor, s2.id, stop(cs[1].id, { visitDays: maskOf([WED]), every: 4, note: 'Back door' }), s2.version);
      expect(stops.find((s) => s.id === s2.id)).toMatchObject({ visitDays: maskOf([WED]), every: 4, note: 'Back door', version: s2.version + 1 });
      await expect(c.salesRoutes.updateStop(companyId, actor, s2.id, stop(cs[1].id), s2.version)).rejects.toThrow('Someone else changed this stop');
      await expect(c.salesRoutes.updateStop(companyId, actor, s2.id, stop(cs[3].id), s2.version + 1)).rejects.toThrow('keeps its customer');

      // Reorder: it must name every stop once.
      stops = await c.salesRoutes.reorder(companyId, actor, r.id, [s4.id, s3.id, s2.id, s1.id]);
      expect(stops.map((s) => [s.id, s.sequence])).toEqual([[s4.id, 1], [s3.id, 2], [s2.id, 3], [s1.id, 4]]);
      await expect(c.salesRoutes.reorder(companyId, actor, r.id, [s1.id, s2.id])).rejects.toThrow('changed since you opened it');
      await expect(c.salesRoutes.reorder(companyId, actor, r.id, [s1.id, s1.id, s2.id, s3.id])).rejects.toThrow('changed since you opened it');
      await expect(c.salesRoutes.reorder(companyId, actor, r.id, [s1.id, s2.id, s3.id, s4.id, randomUUID()])).rejects.toThrow('changed since you opened it');
      expect((await c.salesRoutes.stops(companyId, r.id)).map((s) => s.id)).toEqual([s4.id, s3.id, s2.id, s1.id]);

      // Moving one place up or down, and the ends.
      stops = await c.salesRoutes.moveStop(companyId, actor, r.id, s1.id, -1);
      expect(stops.map((s) => s.id)).toEqual([s4.id, s3.id, s1.id, s2.id]);
      await expect(c.salesRoutes.moveStop(companyId, actor, r.id, s4.id, -1)).rejects.toThrow('already first');
      await expect(c.salesRoutes.moveStop(companyId, actor, r.id, s2.id, 1)).rejects.toThrow('already last');
      await expect(c.salesRoutes.moveStop(companyId, actor, r.id, s2.id, 2)).rejects.toThrow('up or down one place');

      // Taking one off closes the round up, and the customer can be added again.
      const latest = (await c.salesRoutes.stops(companyId, r.id)).find((s) => s.id === s3.id);
      stops = await c.salesRoutes.removeStop(companyId, actor, s3.id, latest?.version ?? 0);
      expect(stops.map((s) => [s.id, s.sequence])).toEqual([[s4.id, 1], [s1.id, 2], [s2.id, 3]]);
      await expect(c.salesRoutes.removeStop(companyId, actor, s3.id, 1)).rejects.toThrow('no longer on this route');
      stops = await c.salesRoutes.addStop(companyId, actor, r.id, stop(cs[2].id));
      expect(stops.at(-1)).toMatchObject({ customerId: cs[2].id, sequence: 4 });
      const rows = await db.select().from(schema.routeStops).where(eq(schema.routeStops.routeId, r.id));
      expect(rows).toHaveLength(5); // the one taken off is kept
      const actions = new Set((await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, r.id))).map((l) => l.action));
      for (const a of ['route.stop_added', 'route.stop_changed', 'route.stops_ordered', 'route.stop_removed']) expect(actions.has(a), a).toBe(true);
    });

    it('say who is due on a date, in the order of the round', async () => {
      const r = await route();
      const [a, b, c2, d] = await Promise.all([customer(), customer(), customer(), customer()]);
      await c.salesRoutes.addStop(companyId, actor, r.id, stop(a.id, { visitDays: maskOf([MON]) }));
      await c.salesRoutes.addStop(companyId, actor, r.id, stop(b.id, { visitDays: maskOf([WED]) }));
      await c.salesRoutes.addStop(companyId, actor, r.id, stop(c2.id, { visitDays: maskOf([MON]), every: 2 }));
      await c.salesRoutes.addStop(companyId, actor, r.id, stop(d.id, { visitDays: maskOf([MON]), anchor: '2026-12-07' }));
      const ids = async (date: string) => (await c.salesRoutes.dueOn(companyId, r.id, date)).map((s) => s.customerId);
      expect(await ids('2026-11-02')).toEqual([a.id, c2.id]); // a Monday: a weekly, c fortnightly from this week; d has not started
      expect(await ids('2026-11-04')).toEqual([b.id]); // the Wednesday
      expect(await ids('2026-11-09')).toEqual([a.id]); // next Monday: c is off this week
      expect(await ids('2026-11-16')).toEqual([a.id, c2.id]);
      expect(await ids('2026-12-07')).toEqual([a.id, d.id]); // d starts; c's week is off
      expect(await ids('2026-11-03')).toEqual([]);
      await expect(c.salesRoutes.dueOn(companyId, r.id, '2026-02-30')).rejects.toThrow('real date');
    });
  });

  describe('usual stock', () => {
    it('is set as a list of products each once, replaced as a whole, read with names and units, and cleared by an empty list', async () => {
      const r = await route();
      const [p1, p2, p3] = await Promise.all([product(), product(), product()]);
      // A product counted in whole pieces takes no fraction.
      await expect(c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: p1, quantity: 6.5 }], r.version)).rejects.toThrow('must be a whole number');
      expect(await c.salesRoutes.par(companyId, r.id)).toEqual([]);
      const set = await c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: p1, quantity: 24 }, { productId: p2, quantity: 6 }], r.version);
      expect(set.map((x) => [x.productId, x.quantity])).toEqual([...set].sort((a, b) => a.productName.localeCompare(b.productName)).map((x) => [x.productId, x.quantity]));
      expect(set.find((x) => x.productId === p1)).toMatchObject({ quantity: 24, unitName: 'Piece', decimals: 0 });
      expect(set.find((x) => x.productId === p2)?.quantity).toBe(6);
      expect((await c.salesRoutes.get(companyId, r.id)).parLines).toBe(2);
      const v2 = (await c.salesRoutes.get(companyId, r.id)).version;
      expect(v2).toBe(r.version + 1);
      const replaced = await c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: p2, quantity: 10 }, { productId: p3, quantity: 1 }], v2);
      expect(replaced.map((x) => x.productId).sort()).toEqual([p2, p3].sort());
      expect(replaced.find((x) => x.productId === p2)?.quantity).toBe(10);
      await expect(c.salesRoutes.setPar(companyId, actor, r.id, [], r.version)).rejects.toThrow('Someone else changed this route');
      const cleared = await c.salesRoutes.setPar(companyId, actor, r.id, [], v2 + 1);
      expect(cleared).toEqual([]);
      expect((await c.salesRoutes.get(companyId, r.id)).parLines).toBe(0);
    });

    it('refuses a product listed twice, a quantity of nothing, a product that is gone or not kept in stock, and a stopped route', async () => {
      const r = await route();
      const p = await product();
      await expect(c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: p, quantity: 1 }, { productId: p, quantity: 2 }], r.version)).rejects.toThrow('listed once');
      await expect(c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: p, quantity: 0 }], r.version)).rejects.toThrow('more than nothing');
      await expect(c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: `prod_${randomUUID()}`, quantity: 1 }], r.version)).rejects.toThrow('could not be found');
      const gone = await product({ deletedAt: new Date() });
      await expect(c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: gone, quantity: 1 }], r.version)).rejects.toThrow('could not be found');
      const service = await product({ inventoryKind: 'service' });
      await expect(c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: service, quantity: 1 }], r.version)).rejects.toThrow('not kept in stock');
      expect(await c.salesRoutes.par(companyId, r.id)).toEqual([]);
      const stopped = await c.salesRoutes.setActive(companyId, actor, r.id, { active: false, reason: 'Seasonal route', expectedVersion: r.version });
      await expect(c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: p, quantity: 1 }], stopped.version)).rejects.toThrow('route is stopped');
    });
  });

  describe('held by the database itself', () => {
    it('refuses wrong values whichever way they arrive', async () => {
      const r = await route();
      const a = await customer();
      await c.salesRoutes.addStop(companyId, actor, r.id, stop(a.id));
      const stopRow = (await c.salesRoutes.stops(companyId, r.id))[0];
      const p = await product();
      await c.salesRoutes.setPar(companyId, actor, r.id, [{ productId: p, quantity: 3 }], r.version);
      const bad = async (table: string, set: string, where: string) => await refusedBy(db.execute(sql.raw(`UPDATE ${table} SET ${set} WHERE ${where}`)));
      const forRoute = `id = '${r.id}'`;
      expect(await bad('sales_routes', "status = 'stopped'", forRoute)).toContain('sales_routes_stopped_reason_chk');
      expect(await bad('sales_routes', "mode = 'walking'", forRoute)).toContain('sales_routes_mode_chk');
      expect(await bad('sales_routes', "status = 'gone', status_reason = 'x'", forRoute)).toContain('sales_routes_status_chk');
      const v = await van();
      expect(await bad('sales_routes', `mode = 'pre_sell', default_van_id = '${v.id}'`, forRoute)).toContain('sales_routes_pre_sell_van_chk');
      const stopId = `id = '${stopRow?.id ?? ''}'`;
      expect(await bad('route_stops', 'visit_days = 0', stopId)).toContain('route_stops_days_chk');
      expect(await bad('route_stops', 'visit_days = 128', stopId)).toContain('route_stops_days_chk');
      expect(await bad('route_stops', 'every_weeks = 3', stopId)).toContain('route_stops_every_chk');
      expect(await bad('route_stops', 'sequence = 0', stopId)).toContain('route_stops_sequence_chk');
      expect(await bad('route_par_levels', 'quantity = 0', `route_id = '${r.id}'`)).toContain('route_par_quantity_chk');
      // The same customer twice among the active stops of a route is refused by the index too.
      expect(await refusedBy(db.insert(schema.routeStops).values({ companyId, routeId: r.id, customerId: a.id, sequence: 9, visitDays: 1, everyWeeks: 1, anchorDate: '2026-11-02' }))).toContain('route_stops_route_customer_uidx');
    });
  });
});
