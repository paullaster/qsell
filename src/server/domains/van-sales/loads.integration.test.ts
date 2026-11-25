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
 * Loading a van (database): the planner suggests the route's usual stock less what is on the van as far as the warehouse can give it; a load is a
 * stock transfer from a warehouse to the van, asked for, approved where the company wants, sent and signed for by the rep (or by the office on their
 * behalf, with a reason); what is on the van follows what was signed for; a day with stock loaded is not cancelled until the stock is back; and the
 * database refuses wrong values on its own. Needs the company's stock-by-location ledger, switched on for the length of the file.
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

describe.skipIf(url === undefined || url === '')('loading a van (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let release: () => Promise<void> = () => Promise.resolve();
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let warehouse: string;
  let mainStock: string;
  const actor: Actor = { type: 'user', id: 'load-test' };
  const reason = { code: 'POLICY_CHANGE' };
  const tag = randomUUID().slice(0, 6);
  let seq = 0;
  const next = () => ++seq;
  const name = (base: string) => `${base} ${tag}${String(next())}`;
  const monday = firstMonday();
  const planner = { maySell: false, mayPlan: true };
  const repOnly = { maySell: true, mayPlan: false };

  const product = async (stock: number, where = warehouse) => {
    const id = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `LD-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `LDS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: name('Crate'), slug: `ld-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50' });
    if (stock > 0) await db.transaction(async (tx) => await c.stockLedger.post(tx, { companyId, productId: id, locationId: where, type: 'receipt', quantity: stock, unitCost: 50, actor: { type: 'user', id: 'seed' }, note: 'seed' }));
    return id;
  };
  const at = async (productId: string, locationId: string) => (await db.select({ n: schema.stockBalances.onHand }).from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, locationId))).limit(1))[0]?.n ?? 0;
  const person = async () => {
    const [u] = await db.insert(schema.users).values({ email: `ld-${randomUUID().slice(0, 8)}@load.test`, passwordHash: 'x', name: name('LRep'), role: 'super_admin' }).returning();
    if (u === undefined) throw new Error('no user');
    return u;
  };
  /** A route with usual stock, a van, a rep and a day planned for the Monday. */
  const setup = async (par: [string, number][], over: { mode?: string } = {}) => {
    const mode = over.mode ?? 'van_sell';
    const user = await person();
    const rep = await c.salesReps.create(companyId, actor, { userId: user.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: { maxDiscountPercent: 0, maxCreditPerDay: 0, mayOverridePrice: false, maySellOnCredit: false } });
    const van = mode === 'pre_sell' ? null : await c.vans.create(companyId, actor, { name: name('LVan'), branchId, vehicleId: null, cashAccountId: null, maxCash: null });
    const route = await c.salesRoutes.create(companyId, actor, { code: `L${tag}${String(next())}`.toUpperCase(), name: name('LRoute'), branchId, mode, defaultVanId: van?.id ?? null, defaultRepId: rep.id });
    const [cust] = await db.insert(schema.customers).values({ companyId, number: `LD${tag}${String(next())}`.toUpperCase(), name: name('Duka'), accountType: 'cash' }).returning();
    await c.salesRoutes.addStop(companyId, actor, route.id, { customerId: cust?.id ?? '', visitDays: maskOf([0]), every: 1, anchor: monday, note: '' });
    if (par.length > 0) await c.salesRoutes.setPar(companyId, actor, route.id, par.map(([productId, quantity]) => ({ productId, quantity })), (await c.salesRoutes.get(companyId, route.id)).version);
    const day = (await c.vanDays.plan(companyId, actor, { routeId: route.id, date: monday })).day;
    return { user, rep, van, route, day };
  };
  const as = (user: { id: string }): Actor => ({ type: 'user', id: user.id });
  const lines = (...rows: [string, number][]) => rows.map(([productId, quantity]) => ({ productId, quantity }));
  const load = async (dayId: string, rows: [string, number][], over: Record<string, unknown> = {}) => (await c.vanLoads.create(companyId, actor, dayId, { kind: 'load', fromLocationId: warehouse, lines: lines(...rows), ...over })).at(-1);
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
    itemTypeId = `it_ld_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    // The load tests run in a branch of their own with a warehouse of its own, so the place a load comes from by default is known.
    const [branch] = await db.insert(schema.branches).values({ companyId, name: name('Load branch'), code: `LB${tag}${String(next())}`.toUpperCase().slice(0, 10) } as never).returning();
    branchId = branch?.id ?? '';
    warehouse = (await c.stockLocations.create(companyId, { code: `LW${tag}`.toUpperCase(), name: `Load warehouse ${tag}`, kind: 'warehouse', branchId })).id;
    mainStock = (await c.stockLocations.ensureDefault(companyId)).id;
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    const now = await c.vanSalesSettings.screen(companyId);
    await c.vanSalesSettings.save(companyId, actor, { ...VAN_SALES_DEFAULTS, ...now.settings, vanSell: true, preSell: true }, now.version, reason);
  }, 120_000);

  afterAll(async () => {
    await db.update(schema.stockSettings).set({ transferRequiresApproval: false }).where(eq(schema.stockSettings.companyId, companyId));
    await db.update(schema.vanDays).set({ status: 'cancelled', statusReason: 'Cleared after a test run' }).where(sql`${schema.vanDays.status} IN ('planned','loading','out','returning','reconciling')`);
    await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared after a test run' }).where(eq(schema.salesRoutes.status, 'active'));
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
    await release();
  }, 120_000);

  describe('the planner', () => {
    it('suggests the route\'s usual stock less what is on the van, as far as the warehouse can give it, and says what is short', async () => {
      const [p1, p2, p3] = [await product(100), await product(4), await product(0)];
      const s = await setup([[p1, 20], [p2, 10], [p3, 5]]);
      const suggestion = await c.vanLoads.suggest(companyId, s.day.id);
      expect(suggestion.source).toMatchObject({ id: warehouse });
      expect(suggestion.note).toBeNull();
      const row = (id: string) => suggestion.rows.find((r) => r.productId === id);
      expect(row(p1)).toMatchObject({ par: 20, onVan: 0, drops: 0, wanted: 20, available: 100, loadable: 20, short: 0 });
      expect(row(p2)).toMatchObject({ wanted: 10, available: 4, loadable: 4, short: 6 });
      expect(row(p3)).toMatchObject({ wanted: 5, available: 0, loadable: 0, short: 5 });
      expect(suggestion.rows.map((r) => r.productName)).toEqual([...suggestion.rows.map((r) => r.productName)].sort());
    });

    it('takes the place to load from as chosen, and says why there is nothing to suggest', async () => {
      const p = await product(50);
      const s = await setup([[p, 10]]);
      const fromMain = await c.vanLoads.suggest(companyId, s.day.id, mainStock);
      expect(fromMain.source?.id).toBe(mainStock);
      expect(fromMain.rows[0]).toMatchObject({ wanted: 10, available: 0, loadable: 0 });
      await expect(c.vanLoads.suggest(companyId, s.day.id, randomUUID())).rejects.toThrow('warehouse or store that is in use');
      await expect(c.vanLoads.suggest(companyId, s.day.id, s.van?.locationId)).rejects.toThrow('warehouse or store that is in use');
      const noPar = await setup([]);
      expect((await c.vanLoads.suggest(companyId, noPar.day.id)).note).toContain('no usual stock');
      const preSell = await setup([[p, 1]], { mode: 'pre_sell' });
      expect(await c.vanLoads.suggest(companyId, preSell.day.id)).toMatchObject({ source: null, rows: [], note: 'A day that only takes orders has no van to load.' });
      await expect(c.vanLoads.suggest(companyId, randomUUID())).rejects.toThrow('day could not be found');
    });
  });

  describe('a load', () => {
    it('is made up as a transfer to the van, asked for, and puts the day into loading, with its history', async () => {
      const p = await product(100);
      const s = await setup([[p, 20]]);
      const made = await load(s.day.id, [[p, 20]]);
      expect(made).toMatchObject({ kind: 'load', state: 'requested', stateWords: 'Asked for', signedAt: null, cancelledAt: null, steps: { approve: false, ship: true, sign: false, cancel: true } });
      expect(made?.number).toMatch(/^TRF|^ST|-/);
      expect(made?.lines).toEqual([{ productId: p, productName: expect.any(String) as string, asked: 20, shipped: 0, received: 0, inTransit: 0 }]);
      const detail = await c.vanDays.find(companyId, s.day.id);
      expect(detail?.day.status).toBe('loading');
      expect(detail?.events.map((e) => e.action)).toEqual(['day.planned', 'day.loading', 'day.load_created']);
      const [doc] = await db.select().from(schema.stockDocuments).where(eq(schema.stockDocuments.id, made?.transferId ?? ''));
      expect(doc).toMatchObject({ kind: 'transfer', fromLocationId: warehouse, toLocationId: s.van?.locationId, state: 'requested' });
      expect(await at(p, warehouse)).toBe(100); // nothing has left yet
    });

    it('is refused in words: nothing to load, a product twice, a place that is not a warehouse, a day with no van, a second load, a top-up before the day is out', async () => {
      const p = await product(50);
      const s = await setup([[p, 5]]);
      await expect(c.vanLoads.create(companyId, actor, s.day.id, { kind: 'load', fromLocationId: warehouse, lines: [] })).rejects.toThrow('Add at least one product');
      await expect(c.vanLoads.create(companyId, actor, s.day.id, { kind: 'load', fromLocationId: warehouse, lines: lines([p, 1], [p, 2]) })).rejects.toThrow('listed once');
      await expect(c.vanLoads.create(companyId, actor, s.day.id, { kind: 'load', fromLocationId: warehouse, lines: lines([p, 0.5]) })).rejects.toThrow('whole number');
      await expect(c.vanLoads.create(companyId, actor, s.day.id, { kind: 'move', fromLocationId: warehouse, lines: lines([p, 1]) })).rejects.toThrow('day\'s load or a top-up');
      await expect(c.vanLoads.create(companyId, actor, s.day.id, { kind: 'load', fromLocationId: s.van?.locationId, lines: lines([p, 1]) })).rejects.toThrow('warehouse or store that is in use');
      await expect(c.vanLoads.create(companyId, actor, s.day.id, { kind: 'top_up', fromLocationId: warehouse, lines: lines([p, 1]) })).rejects.toThrow('day that is out on the route');
      const preSell = await setup([[p, 1]], { mode: 'pre_sell' });
      await expect(c.vanLoads.create(companyId, actor, preSell.day.id, { kind: 'load', fromLocationId: warehouse, lines: lines([p, 1]) })).rejects.toThrow('has no van');
      await load(s.day.id, [[p, 5]]);
      await expect(c.vanLoads.create(companyId, actor, s.day.id, { kind: 'load', fromLocationId: warehouse, lines: lines([p, 1]) })).rejects.toThrow('already has a load');
      // The refused attempts left no transfer behind.
      const docs = await db.select().from(schema.stockDocuments).where(sql`${schema.stockDocuments.note} LIKE ${`%${s.day.number}%`}`);
      expect(docs).toHaveLength(1);
      await expect(c.vanLoads.create(companyId, actor, randomUUID(), { kind: 'load', lines: lines([p, 1]) })).rejects.toThrow('day could not be found');
    });

    it('is sent, which takes the stock out of the warehouse, and signed for by the rep, which puts it on the van', async () => {
      const p = await product(100);
      const s = await setup([[p, 20]]);
      const made = await load(s.day.id, [[p, 20]]);
      const sent = (await c.vanLoads.ship(companyId, actor, made?.id ?? '')).at(-1);
      expect(sent).toMatchObject({ state: 'shipped', stateWords: 'On its way to the van', steps: { approve: false, ship: false, sign: true, cancel: false } });
      expect(sent?.lines[0]).toMatchObject({ shipped: 20, received: 0, inTransit: 20 });
      expect(await at(p, warehouse)).toBe(80);
      expect(await at(p, s.van?.locationId ?? '')).toBe(0);
      expect(await c.vanLoads.onVan(companyId, s.day.id)).toEqual([]);

      const signed = (await c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, repOnly)).at(-1);
      expect(signed).toMatchObject({ state: 'received', stateWords: 'Signed for', signedByName: s.user.name, signedOnBehalf: false, signReason: null, steps: { sign: false } });
      expect(signed?.signedAt).not.toBeNull();
      expect(signed?.lines[0]).toMatchObject({ received: 20, inTransit: 0 });
      expect(await at(p, s.van?.locationId ?? '')).toBe(20);
      expect(await c.vanLoads.onVan(companyId, s.day.id)).toEqual([expect.objectContaining({ productId: p, onHand: 20, reserved: 0 })]);
      await expect(c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, repOnly)).rejects.toThrow('already signed for');
      const events = (await c.vanDays.find(companyId, s.day.id))?.events ?? [];
      expect(events.map((e) => e.action)).toEqual(['day.planned', 'day.loading', 'day.load_created', 'day.load_shipped', 'day.load_signed']);
      // What is on the van now counts against the next suggestion.
      const after = await c.vanLoads.suggest(companyId, s.day.id);
      expect(after.rows).toEqual([]);
      expect(after.note).toBe('The van already has its usual stock.');
    });

    it('is refused the stock the warehouse does not have, naming it, and stays asked for', async () => {
      const p = await product(5);
      const s = await setup([[p, 50]]);
      const made = await load(s.day.id, [[p, 50]]);
      await expect(c.vanLoads.ship(companyId, actor, made?.id ?? '')).rejects.toThrow(/has 5 of .* that is not promised to a customer, and 50 are to be shipped/);
      expect((await c.vanLoads.list(companyId, s.day.id))[0]?.state).toBe('requested');
      expect(await at(p, warehouse)).toBe(5);
    });
  });

  describe('signing', () => {
    it('is the rep\'s, or the office\'s on their behalf with a reason, and anyone else is refused', async () => {
      const p = await product(100);
      const s = await setup([[p, 10]]);
      const made = await load(s.day.id, [[p, 10]]);
      await c.vanLoads.ship(companyId, actor, made?.id ?? '');
      const stranger = await person();
      await expect(c.vanLoads.sign(companyId, as(stranger), made?.id ?? '', {}, repOnly)).rejects.toThrow(`Only ${s.rep.name} signs for their own load`);
      await expect(c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, { maySell: false, mayPlan: false })).rejects.toThrow('not allowed to sign');
      await expect(c.vanLoads.sign(companyId, actor, made?.id ?? '', {}, planner)).rejects.toThrow(`Signing for ${s.rep.name} needs a reason`);
      await expect(c.vanLoads.sign(companyId, actor, made?.id ?? '', { reason: 'ok' }, planner)).rejects.toThrow('needs a reason');
      expect(await at(p, s.van?.locationId ?? '')).toBe(0);
      const done = (await c.vanLoads.sign(companyId, actor, made?.id ?? '', { reason: 'The rep signed the paper copy at the depot' }, planner)).at(-1);
      expect(done).toMatchObject({ signedOnBehalf: true, signReason: 'The rep signed the paper copy at the depot', state: 'received' });
      expect(await at(p, s.van?.locationId ?? '')).toBe(10);
      const signedEvent = (await c.vanDays.find(companyId, s.day.id))?.events.at(-1);
      expect(signedEvent).toMatchObject({ action: 'day.load_signed', reason: 'The rep signed the paper copy at the depot' });
    });

    it('takes what the rep counted: less than was sent leaves the rest in transit to be settled, and more, an unknown product or nothing is refused', async () => {
      const [p, q] = [await product(100), await product(100)];
      const s = await setup([[p, 10], [q, 10]]);
      const made = await load(s.day.id, [[p, 10], [q, 10]]);
      await c.vanLoads.ship(companyId, actor, made?.id ?? '');
      await expect(c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', { entries: [{ productId: p, quantity: 11 }] }, repOnly)).rejects.toThrow('Only 10 of');
      await expect(c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', { entries: [{ productId: 'prod_other', quantity: 1 }] }, repOnly)).rejects.toThrow('not on this load');
      await expect(c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', { entries: [{ productId: p, quantity: 0 }] }, repOnly)).rejects.toThrow('Count at least one product');
      await expect(c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', { entries: [{ productId: p, quantity: -1 }] }, repOnly)).rejects.toThrow('less than nothing');
      const signed = (await c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', { entries: [{ productId: p, quantity: 10 }, { productId: q, quantity: 7 }] }, repOnly)).at(-1);
      expect(signed).toMatchObject({ state: 'partly_received', stateWords: 'Partly signed for' });
      expect(signed?.lines.find((l) => l.productId === q)).toMatchObject({ received: 7, inTransit: 3 });
      expect(await at(q, s.van?.locationId ?? '')).toBe(7);
      // It is signed once; what did not arrive is settled under Stock > Transfers.
      await expect(c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, repOnly)).rejects.toThrow('already signed for');
    });

    it('is refused before the load has left the warehouse', async () => {
      const p = await product(20);
      const s = await setup([[p, 5]]);
      const made = await load(s.day.id, [[p, 5]]);
      await expect(c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, repOnly)).rejects.toThrow('has not left the warehouse yet');
      await expect(c.vanLoads.sign(companyId, as(s.user), 'x', {}, repOnly)).rejects.toThrow('load could not be found');
    });
  });

  describe('approval', () => {
    it('is asked of a second person where the company wants it, before the load can be sent', async () => {
      const p = await product(30);
      const s = await setup([[p, 5]]);
      await db.update(schema.stockSettings).set({ transferRequiresApproval: true }).where(eq(schema.stockSettings.companyId, companyId));
      try {
        const made = await load(s.day.id, [[p, 5]]);
        expect(made?.steps).toMatchObject({ approve: true, ship: false, cancel: true });
        await expect(c.vanLoads.ship(companyId, actor, made?.id ?? '')).rejects.toThrow('needs a second person to approve');
        await expect(c.vanLoads.approve(companyId, actor, made?.id ?? '')).rejects.toThrow('Someone other than the person who asked');
        const approved = (await c.vanLoads.approve(companyId, { type: 'user', id: 'second-person' }, made?.id ?? '')).at(-1);
        expect(approved).toMatchObject({ state: 'approved', steps: { approve: false, ship: true } });
        expect((await c.vanLoads.ship(companyId, actor, made?.id ?? '')).at(-1)?.state).toBe('shipped');
        expect((await c.vanDays.find(companyId, s.day.id))?.events.map((e) => e.action)).toContain('day.load_approved');
      } finally {
        await db.update(schema.stockSettings).set({ transferRequiresApproval: false }).where(eq(schema.stockSettings.companyId, companyId));
      }
    });
  });

  describe('calling a load off', () => {
    it('is possible only before it has left the warehouse, needs a reason, and lets the day make another', async () => {
      const p = await product(30);
      const s = await setup([[p, 5]]);
      const made = await load(s.day.id, [[p, 5]]);
      await expect(c.vanLoads.cancel(companyId, actor, made?.id ?? '', '')).rejects.toThrow('Say why');
      const off = (await c.vanLoads.cancel(companyId, actor, made?.id ?? '', 'The van is being repaired')).at(0);
      expect(off).toMatchObject({ state: 'cancelled', stateWords: 'Cancelled', cancelReason: 'The van is being repaired', steps: { ship: false, cancel: false } });
      await expect(c.vanLoads.cancel(companyId, actor, made?.id ?? '', 'Again please')).rejects.toThrow('already called off');
      await expect(c.vanLoads.ship(companyId, actor, made?.id ?? '')).rejects.toThrow('called off');
      const again = await load(s.day.id, [[p, 5]]);
      expect(again?.id).not.toBe(made?.id);
      await c.vanLoads.ship(companyId, actor, again?.id ?? '');
      await expect(c.vanLoads.cancel(companyId, actor, again?.id ?? '', 'Changed my mind')).rejects.toThrow();
      expect((await c.vanLoads.list(companyId, s.day.id)).map((l) => l.state)).toEqual(['cancelled', 'shipped']);
    });
  });

  describe('a day with stock loaded', () => {
    it('is not cancelled while a load has not left, is on its way, or its stock is on the van, and is once the stock is back', async () => {
      const p = await product(50);
      const s = await setup([[p, 10]]);
      const version = async () => (await c.vanDays.find(companyId, s.day.id))?.day.version;
      const made = await load(s.day.id, [[p, 10]]);
      await expect(c.vanDays.cancel(companyId, actor, s.day.id, { reason: 'Customers closed', expectedVersion: await version() })).rejects.toThrow('has not left the warehouse');
      await c.vanLoads.ship(companyId, actor, made?.id ?? '');
      await expect(c.vanDays.cancel(companyId, actor, s.day.id, { reason: 'Customers closed', expectedVersion: await version() })).rejects.toThrow('on its way to the van');
      await c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, repOnly);
      await expect(c.vanDays.cancel(companyId, actor, s.day.id, { reason: 'Customers closed', expectedVersion: await version() })).rejects.toThrow('still on the van');
      // The stock goes back by a transfer from the van to the warehouse.
      const back = await c.stockTransfers.create(companyId, { id: actor.id ?? '' }, { fromLocationId: s.van?.locationId ?? '', toLocationId: warehouse, note: 'Back', lines: lines([p, 10]) });
      await c.stockTransfers.request(companyId, { id: actor.id ?? '' }, back.id);
      await c.stockTransfers.ship(companyId, { id: actor.id ?? '' }, back.id);
      const line = (await c.stockTransfers.get(companyId, back.id)).lines[0]?.id ?? '';
      await c.stockTransfers.receive(companyId, { id: actor.id ?? '' }, back.id, [{ lineId: line, quantity: 10 }]);
      expect(await at(p, s.van?.locationId ?? '')).toBe(0);
      const done = await c.vanDays.cancel(companyId, actor, s.day.id, { reason: 'Customers closed', expectedVersion: await version() });
      expect(done.day.status).toBe('cancelled');
    });
  });

  describe('a top-up', () => {
    it('is made while the day is out, in the same way, and the day\'s load cannot be made then', async () => {
      const p = await product(100);
      const s = await setup([[p, 10]]);
      await db.update(schema.vanDays).set({ status: 'out' }).where(eq(schema.vanDays.id, s.day.id));
      await expect(c.vanLoads.create(companyId, actor, s.day.id, { kind: 'load', fromLocationId: warehouse, lines: lines([p, 5]) })).rejects.toThrow('before the day goes out');
      const top = (await c.vanLoads.create(companyId, actor, s.day.id, { kind: 'top_up', fromLocationId: warehouse, lines: lines([p, 5]) })).at(-1);
      expect(top).toMatchObject({ kind: 'top_up', state: 'requested' });
      await c.vanLoads.ship(companyId, actor, top?.id ?? '');
      await c.vanLoads.sign(companyId, as(s.user), top?.id ?? '', {}, repOnly);
      // Another top-up is allowed; the day stays out.
      expect((await c.vanLoads.create(companyId, actor, s.day.id, { kind: 'top_up', fromLocationId: warehouse, lines: lines([p, 2]) })).map((l) => l.kind)).toEqual(['top_up', 'top_up']);
      expect(await at(p, s.van?.locationId ?? '')).toBe(5);
      expect((await c.vanDays.find(companyId, s.day.id))?.day.status).toBe('out');
    });
  });

  describe('held by the database itself', () => {
    it('refuses wrong values whichever way they arrive', async () => {
      const p = await product(30);
      const s = await setup([[p, 5]]);
      const made = await load(s.day.id, [[p, 5]]);
      const bad = async (set: string) => await refusedBy(db.execute(sql.raw(`UPDATE van_loads SET ${set} WHERE id = '${made?.id ?? ''}'`)));
      expect(await bad("kind = 'unload'")).toContain('van_loads_kind_chk');
      expect(await bad("signed_by = 'someone'")).toContain('van_loads_signed_chk');
      expect(await bad("signed_on_behalf = true")).toContain('van_loads_behalf_chk');
      expect(await bad("cancelled_at = now()")).toContain('van_loads_cancelled_chk');
      expect(await bad("signed_by = 'x', signed_at = now(), cancelled_at = now(), cancel_reason = 'y'")).toContain('van_loads_cancelled_chk');
      // The same transfer cannot be tied to two loads, and a day has one load that is still wanted.
      const other = await setup([[p, 5]]);
      expect(await refusedBy(db.insert(schema.vanLoads).values({ companyId, dayId: other.day.id, kind: 'top_up', transferId: made?.transferId ?? '', fromLocationId: warehouse, createdBy: 'x' }))).toContain('van_loads_transfer_uidx');
      expect(await refusedBy(db.insert(schema.vanLoads).values({ companyId, dayId: s.day.id, kind: 'load', transferId: (await c.stockTransfers.create(companyId, { id: 'x' }, { fromLocationId: warehouse, toLocationId: s.van?.locationId ?? '', note: 'dup', lines: lines([p, 1]) })).id, fromLocationId: warehouse, createdBy: 'x' }))).toContain('van_loads_day_load_uidx');
    });
  });
});
