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
 * Cash on the van (database): the cash the van's till holds against its limit, cash drops made by the rep out of the shift, and the
 * database refusing wrong values on its own.
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

describe.skipIf(url === undefined || url === '')('cash on the van (database)', () => {
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
  const refusedBy = async (p: Promise<unknown>) => {
    const e = (await p.then(() => null, (err: unknown) => err)) as { message?: string; cause?: { message?: string } } | null;
    return e === null ? null : `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  };

  /** A planned day (route with both modes and a van) with two customers on its visits, a product at the warehouse, and the rep. */
  const plannedDay = async (over: { warehouseStock?: number; mode?: string; maxCash?: number | null } = {}) => {
    const mode = over.mode ?? 'both';
    const user = await person();
    const rep = await c.salesReps.create(companyId, actor, { userId: user.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: noLimits });
    const van = mode === 'pre_sell' ? null : await c.vans.create(companyId, actor, { name: name('DVan'), branchId, vehicleId: null, cashAccountId: null, maxCash: over.maxCash === undefined ? null : over.maxCash });
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


  /** A day that is out with the van's till opened on a counted float. */
  const outWithFloat = async (over: { float: number; maxCash?: number | null }) => {
    const s = await plannedDay({ maxCash: over.maxCash ?? null });
    const made = await load(s, [{ productId: s.p, quantity: 5 }]);
    await c.vanLoads.ship(companyId, actor, made?.id ?? '');
    await c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, { maySell: true, mayPlan: false });
    await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: over.float, expectedVersion: (await c.vanDays.find(companyId, s.day.id))?.day.version }, true);
    return s;
  };
  const drop = async (s: Planned, over: Record<string, unknown> = {}, user: { id: string } = s.user) => await c.vanCash.drop(companyId, as(user), s.day.id, { amount: 1000, destination: 'safe', note: '', ...over }, true);

  describe('the cash on the van', () => {
    it('is the till\'s expected cash against the van\'s limit, with words only when it is near or over', async () => {
      const s = await outWithFloat({ float: 4000, maxCash: 10000 });
      expect(await c.vanCash.forDay(companyId, s.day.id)).toMatchObject({ cash: 4000, limit: 10000, state: 'ok', words: null, drops: [], dropped: 0 });
      const near = await outWithFloat({ float: 9500, maxCash: 10000 });
      expect(await c.vanCash.forDay(companyId, near.day.id)).toMatchObject({ cash: 9500, state: 'near', words: expect.stringContaining('close to its cash limit') as string });
      const over = await outWithFloat({ float: 12500, maxCash: 10000 });
      expect(await c.vanCash.forDay(companyId, over.day.id)).toMatchObject({ state: 'over', words: expect.stringContaining('2500') as string });
      const free = await outWithFloat({ float: 99999, maxCash: null });
      expect(await c.vanCash.forDay(companyId, free.day.id)).toMatchObject({ limit: null, state: 'no_limit', words: null });
    });

    it('is nothing for a day with no van till', async () => {
      const s = await plannedDay();
      expect(await c.vanCash.forDay(companyId, s.day.id)).toBeNull();
      expect(await c.vanCash.forDay(companyId, 'nope')).toBeNull();
    });
  });

  describe('a cash drop', () => {
    it('is a paid-out of the van\'s shift, with where it went, in the day\'s history, and brings the cash under the limit', async () => {
      const s = await outWithFloat({ float: 12500, maxCash: 10000 });
      await drop(s, { amount: 3000, destination: 'bank_run', note: 'Banked at the branch' });
      const view = await c.vanCash.forDay(companyId, s.day.id);
      expect(view).toMatchObject({ cash: 9500, state: 'near', dropped: 3000 });
      expect(view?.drops).toEqual([expect.objectContaining({ amount: 3000, destination: 'bank_run', destinationWords: 'A bank run', note: 'Banked at the branch', witnessed: false })]);
      const [row] = await db.select().from(schema.vanCashDrops).where(eq(schema.vanCashDrops.dayId, s.day.id));
      const [move] = await db.select().from(schema.shiftMovements).where(eq(schema.shiftMovements.id, row?.movementId ?? ''));
      expect(move).toMatchObject({ kind: 'paid_out', amount: '3000.00', createdBy: s.user.id });
      expect(move?.reason).toContain('Cash drop to a bank run');
      expect((await c.vanDays.find(companyId, s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.cash_dropped', words: 'Cash was taken off the van' });
      await drop(s, { amount: 9500 });
      expect(await c.vanCash.forDay(companyId, s.day.id)).toMatchObject({ cash: 0, dropped: 12500 });
    });

    it('cannot be more than the van holds, from another person, with a bad amount or place, or before the day is out', async () => {
      const s = await outWithFloat({ float: 2000, maxCash: 10000 });
      await expect(drop(s, { amount: 2000.01 })).rejects.toThrow('cannot take off more');
      await expect(drop(s, { amount: 0 })).rejects.toThrow('how much cash');
      await expect(drop(s, { destination: 'home' })).rejects.toThrow('where the cash is going');
      const other = await person();
      await expect(drop(s, {}, other)).rejects.toThrow('runs their own day');
      await expect(c.vanCash.drop(companyId, as(s.user), s.day.id, { amount: 10, destination: 'safe' }, false)).rejects.toThrow('not allowed to sell from a van');
      const planned = await plannedDay();
      await expect(drop(planned)).rejects.toThrow('while the day is out');
      expect((await c.vanCash.forDay(companyId, s.day.id))?.drops).toEqual([]);
    });
  });

  describe('held by the database itself', () => {
    it('refuses wrong values and a second drop for one movement', async () => {
      const s = await outWithFloat({ float: 2000 });
      await drop(s);
      const [row] = await db.select().from(schema.vanCashDrops).where(eq(schema.vanCashDrops.dayId, s.day.id));
      const bad = async (set: string) => await refusedBy(db.execute(sql.raw(`UPDATE van_cash_drops SET ${set} WHERE id = '${row?.id ?? ''}'`)));
      expect(await bad('amount = 0')).toContain('van_cash_drops_amount_chk');
      expect(await bad("destination = 'pocket'")).toContain('van_cash_drops_destination_chk');
      expect(await bad("witnessed_by = 'someone'")).toContain('van_cash_drops_witness_chk');
      expect(await refusedBy(db.insert(schema.vanCashDrops).values({ companyId, dayId: s.day.id, movementId: row?.movementId ?? '', amount: '1', destination: 'safe', createdBy: 'x' }))).toContain('van_cash_drops_movement_uidx');
    });
  });
});
