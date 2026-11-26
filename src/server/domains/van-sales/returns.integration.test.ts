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
 * Returns at a visit (database): goods a customer gives back from an earlier cash sale made from the same van, as an ordinary counter return
 * with the cash handed back out of the van's till shift and the goods fit to sell again counted back on the van; a retry never returns twice;
 * and the database refusing wrong values on its own.
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

describe.skipIf(url === undefined || url === '')('returns at a visit (database)', () => {
  let c: ReturnType<typeof getContainer>;
  let db: typeof drizzleDb;
  let schema: typeof schemaModule;
  let release: () => Promise<void> = () => Promise.resolve();
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let warehouse: string;
  let cashMethod = '';
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
    const [row] = await db.insert(schema.customers).values({ companyId, number: `SL${tag}${String(next())}`.toUpperCase(), name: name('Duka'), accountType: 'cash', email: `rt-${randomUUID().slice(0, 8)}@return.test`, phone: `0713${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, street: '2 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya', ...over }).returning();
    if (row === undefined) throw new Error('no customer');
    return row;
  };
  const at = async (productId: string, locationId: string) => (await db.select({ n: schema.stockBalances.onHand, r: schema.stockBalances.reserved }).from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, locationId))).limit(1))[0] ?? { n: 0, r: 0 };
  const version = async (dayId: string) => (await c.vanDays.find(companyId, dayId))?.day.version;
  const lines = (productId: string, quantity: number, over: Record<string, unknown> = {}) => [{ productId, quantity, ...over }];
  const pay = (amount: number) => [{ methodId: cashMethod, amount, reference: '' }];
  const refusedBy = async (p: Promise<unknown>) => {
    const e = (await p.then(() => null, (err: unknown) => err)) as { message?: string; cause?: { message?: string } } | null;
    return e === null ? null : `${e.message ?? ''} ${e.cause?.message ?? ''}`;
  };

  /** A day that is out with 20 on the van, two customers (a cash one and one with a credit account), and the rep standing at the first. */
  const outDay = async (over: { limits?: Partial<typeof noLimits>; mode?: string; arrive?: boolean; stock?: number } = {}) => {
    const mode = over.mode ?? 'van_sell';
    const user = await person();
    const rep = await c.salesReps.create(companyId, actor, { userId: user.id, phone: '', homeBranchId: null, modes: ['van_sell', 'pre_sell'], limits: { ...noLimits, ...over.limits } });
    const van = mode === 'pre_sell' ? null : await c.vans.create(companyId, actor, { name: name('SVan'), branchId, vehicleId: null, cashAccountId: null, maxCash: null });
    const route = await c.salesRoutes.create(companyId, actor, { code: `S${tag}${String(next())}`.toUpperCase(), name: name('SRoute'), branchId, mode, defaultVanId: van?.id ?? null, defaultRepId: rep.id });
    const a = await customer();
    const b = await customer({ accountType: 'credit', creditLimit: '100000', paymentTermDays: 30, email: `sl-${randomUUID().slice(0, 8)}@sale.test`, phone: '0711000777', street: '1 Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'Kenya' });
    for (const x of [a, b]) await c.salesRoutes.addStop(companyId, actor, route.id, { customerId: x.id, visitDays: maskOf([0]), every: 1, anchor: monday, note: '' });
    const p = `prod_${randomUUID()}`;
    await db.insert(schema.products).values({ id: p, sku: `SL-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `SLS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: name('Crate'), slug: `sl-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50' });
    await db.transaction(async (tx) => await c.stockLedger.post(tx, { companyId, productId: p, locationId: warehouse, type: 'receipt', quantity: 100, unitCost: 50, actor: { type: 'user', id: 'seed' }, note: 'seed' }));
    let day = (await c.vanDays.plan(companyId, actor, { routeId: route.id, date: monday })).day;
    if (van !== null) {
      await c.salesRoutes.setPar(companyId, actor, route.id, [{ productId: p, quantity: over.stock ?? 20 }], (await c.salesRoutes.get(companyId, route.id)).version).catch(() => undefined);
      const made = (await c.vanLoads.create(companyId, actor, day.id, { kind: 'load', fromLocationId: warehouse, lines: [{ productId: p, quantity: over.stock ?? 20 }] })).at(-1);
      await c.vanLoads.ship(companyId, actor, made?.id ?? '');
      await c.vanLoads.sign(companyId, as(user), made?.id ?? '', {}, { maySell: true, mayPlan: false });
    }
    await c.vanRun.sendOut(companyId, as(user), day.id, { float: 1000, expectedVersion: await version(day.id) }, true);
    day = (await c.vanDays.find(companyId, day.id))?.day ?? day;
    const visits = (await c.vanDays.find(companyId, day.id))?.visits ?? [];
    const [v1, v2] = visits;
    if (over.arrive !== false && v1 !== undefined) await c.vanRun.arrive(companyId, as(user), day.id, v1.id, {}, true);
    return { user, rep, van, route, a, b, p, day, v1, v2 };
  };
  const sell = async (s: Awaited<ReturnType<typeof outDay>>, over: Record<string, unknown> = {}, visitId = s.v1?.id) => await c.vanSales.sell(companyId, as(s.user), s.day.id, { visitId, kind: 'cash', saleKey: randomUUID(), lines: lines(s.p, 2), tenders: pay(200), ...over }, true);

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
    // A chart is applied before any account is added by hand: any account at all stops a template from being applied later, for every file after this one.
    const financeCtx = { companyId, actor, origin: { surface: 'test', action: 'setup' } };
    await c.finance.setup.applyTemplate(financeCtx, 'kenya', { fiscalYearStart: '2026-01-01' }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('already has a chart')) throw error;
    });
    await c.finance.paymentMethods.seedStandard(financeCtx).catch(() => undefined);
    const [existing] = await db.select({ id: schema.paymentProviderConfigs.id }).from(schema.paymentProviderConfigs).limit(1);
    const provider = existing ?? (await db.insert(schema.paymentProviderConfigs).values({ companyId, providerCode: 'manual', displayName: 'Manual', isSystem: true, isEnabled: true, apiBaseUrl: 'https://manual.invalid', environment: 'sandbox' } as never).returning({ id: schema.paymentProviderConfigs.id }))[0];
    const run = randomUUID().slice(0, 6).toUpperCase();
    const [bank] = await db.insert(schema.bankAccounts).values({ companyId, code: `SLC${run}`, name: `Van cash ${run}`, kind: 'cash', currency: 'KES', createdBy: 'test' } as never).returning();
    const [gl] = await db.insert(schema.glAccounts).values({ companyId, no: `17${run}`, name: `Van cash ${run}`, type: 'posting', category: 'assets', normalBalance: 'debit' } as never).returning();
    const [method] = await db.insert(schema.paymentMethods).values({ companyId, providerId: provider?.id ?? '', code: `SLC${run}`, name: `Van cash ${run}`, kind: 'cash', balancingBankAccountId: bank?.id ?? '', glAccountId: gl?.id ?? '', usableFor: ['customer_receipt'], createdBy: 'test' } as never).returning();
    cashMethod = method?.id ?? '';
    await db.update(schema.paymentMethods).set({ usableFor: ['customer_receipt', 'customer_refund'], refundDestination: 'manual' }).where(eq(schema.paymentMethods.id, cashMethod));
  }, 120_000);

  afterAll(async () => {
    await db.update(schema.vanDays).set({ status: 'cancelled', statusReason: 'Cleared after a test run' }).where(sql`${schema.vanDays.status} IN ('planned','loading','out','returning','reconciling')`);
    await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared after a test run' }).where(eq(schema.salesRoutes.status, 'active'));
    await db.update(schema.shifts).set({ status: 'closed', closedAt: new Date(), closedBy: 'test', declaredCash: '0', zNumber: `Z-SL-${tag}` }).where(sql`${schema.shifts.status} IN ('open','closing') AND ${schema.shifts.openedBy} IN (SELECT id::text FROM users WHERE email LIKE '%@sale.test')`).catch(() => undefined);
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
    await release();
  }, 120_000);


  const giveBack = async (s: Awaited<ReturnType<typeof outDay>>, orderId: string, over: Record<string, unknown> = {}, user: { id: string } = s.user) =>
    await c.vanReturns.take(companyId, as(user), s.day.id, { visitId: s.v1?.id, orderId, lines: [{ productId: s.p, quantity: 1 }], reason: { code: 'POLICY_CHANGE', text: 'changed their mind' }, restock: true, refund: { methodId: cashMethod, phone: '' }, key: randomUUID(), ...over }, true);
  const cashOf = async (s: Awaited<ReturnType<typeof outDay>>) => (await c.vanCash.forDay(companyId, s.day.id))?.cash ?? -1;

  describe('taking goods back at a visit', () => {
    it('is a counter return of the van\'s own cash sale: cash handed back from the van\'s shift, the goods fit to sell again back on the van', async () => {
      const s = await outDay();
      const made = await sell(s, { lines: lines(s.p, 4), tenders: pay(400) });
      const van = s.van?.locationId ?? '';
      const before = await at(s.p, van);
      expect(before.n).toBe(16);
      const cashBefore = await cashOf(s);
      const [open] = await c.vanReturns.returnable(companyId, s.day.id);
      expect(open).toMatchObject({ orderNumber: made.orderNumber, visitId: s.v1?.id, lines: [expect.objectContaining({ productId: s.p, remainingQuantity: 4, unitPrice: 100 })] });
      await giveBack(s, made.orderId, { lines: [{ productId: s.p, quantity: 1 }] });
      // The goods are back on the van and the van's till paid the customer back.
      expect((await at(s.p, van)).n).toBe(17);
      expect(await cashOf(s)).toBe(cashBefore - 100);
      const [ret] = await c.vanReturns.forDay(companyId, s.day.id);
      expect(ret).toMatchObject({ amount: 100, restock: true, status: 'completed', customerName: s.a.name, orderNumber: made.orderNumber });
      expect((await c.vanDays.find(companyId, s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.returned', words: 'Goods were taken back from a customer' });
      const [again] = await c.vanReturns.returnable(companyId, s.day.id);
      expect(again?.lines[0]?.remainingQuantity).toBe(3);
    });

    it('leaves damaged goods out of the van\'s stock but still pays the customer back', async () => {
      const s = await outDay();
      const made = await sell(s, { lines: lines(s.p, 2), tenders: pay(200) });
      const cashBefore = await cashOf(s);
      await giveBack(s, made.orderId, { restock: false });
      expect((await at(s.p, s.van?.locationId ?? '')).n).toBe(18);
      expect(await cashOf(s)).toBe(cashBefore - 100);
      expect((await c.vanReturns.forDay(companyId, s.day.id))[0]).toMatchObject({ restock: false, amount: 100 });
    });

    it('finds the return it made when the same key is sent again, and returns the goods once', async () => {
      const s = await outDay();
      const made = await sell(s, { lines: lines(s.p, 3), tenders: pay(300) });
      const key = randomUUID();
      await giveBack(s, made.orderId, { key });
      await giveBack(s, made.orderId, { key });
      expect(await c.vanReturns.forDay(companyId, s.day.id)).toHaveLength(1);
      expect((await at(s.p, s.van?.locationId ?? '')).n).toBe(18);
      expect((await c.vanReturns.returnable(companyId, s.day.id))[0]?.lines[0]?.remainingQuantity).toBe(2);
    });

    it('is refused for more than was sold, someone else\'s sale, another van\'s sale, a sale not made from a van, before arriving, by another person, and with nothing chosen', async () => {
      const s = await outDay();
      const made = await sell(s, { lines: lines(s.p, 2), tenders: pay(200) });
      await expect(giveBack(s, made.orderId, { lines: [{ productId: s.p, quantity: 3 }] })).rejects.toThrow('at most 2');
      await expect(giveBack(s, made.orderId, { lines: [] })).rejects.toThrow('what is being returned');
      await expect(giveBack(s, made.orderId, { reason: {} })).rejects.toThrow('why the goods');
      await expect(giveBack(s, made.orderId, { refund: { methodId: randomUUID(), phone: '' } })).rejects.toThrow('paid back');
      await expect(giveBack(s, made.orderId, {}, await person())).rejects.toThrow('runs their own day');
      await expect(c.vanReturns.take(companyId, as(s.user), s.day.id, {}, false)).rejects.toThrow('not allowed to sell from a van');
      // Another van's sale to another customer cannot be returned at this visit.
      const other = await outDay();
      const theirs = await sell(other, { lines: lines(other.p, 1), tenders: pay(100) });
      await expect(giveBack(s, theirs.orderId)).rejects.toThrow('was not made to');
      // A sale made to the other customer on this same van.
      await c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'sold' }, true);
      await c.vanRun.arrive(companyId, as(s.user), s.day.id, s.v2?.id ?? '', {}, true);
      const bSale = await sell(s, { lines: lines(s.p, 1), tenders: pay(100) }, s.v2?.id);
      await expect(giveBack(s, bSale.orderId, { visitId: s.v1?.id })).rejects.toThrow('Arrive at');
      // An order that was not a van sale at all.
      const plain = await c.salesOrders.place(companyId, { userId: s.user.id, branchId }, { customerId: s.a.id, lines: [{ productId: s.p, quantity: 1 }], paymentMethod: 'counter', neededOn: '', holdUntilPaid: false }, 'sales_order');
      await expect(giveBack(s, plain.ok ? plain.orderId : '', { visitId: s.v2?.id })).rejects.toThrow('not made from a van');
      expect(await c.vanReturns.forDay(companyId, s.day.id)).toEqual([]);
    });

    it('is refused while the day is not out', async () => {
      const s = await outDay();
      const made = await sell(s, { lines: lines(s.p, 1), tenders: pay(100) });
      await db.update(schema.vanDays).set({ status: 'returning' }).where(eq(schema.vanDays.id, s.day.id));
      await expect(giveBack(s, made.orderId)).rejects.toThrow('while the day is out');
    });
  });

  describe('finishing the visit', () => {
    it('is as sold when the same visit made the sale that was returned, and never as no sale', async () => {
      const s = await outDay();
      const made = await sell(s, { lines: lines(s.p, 2), tenders: pay(200) });
      await giveBack(s, made.orderId);
      await expect(c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'no_sale', reason: 'Nothing wanted' }, true)).rejects.toThrow('so the visit is finished as done');
      const done = await c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'sold' }, true);
      expect(done.visits.find((v) => v.id === s.v1?.id)).toMatchObject({ status: 'done', outcome: 'sold' });
    });
  });

  describe('held by the database itself', () => {
    it('refuses a nil amount and a second record for one return', async () => {
      const s = await outDay();
      const made = await sell(s, { lines: lines(s.p, 2), tenders: pay(200) });
      await giveBack(s, made.orderId);
      const [row] = await db.select().from(schema.vanDayReturns).where(eq(schema.vanDayReturns.dayId, s.day.id));
      expect(await refusedBy(db.execute(sql.raw(`UPDATE van_day_returns SET amount = 0 WHERE id = '${row?.id ?? ''}'`)))).toContain('van_day_returns_amount_chk');
      expect(await refusedBy(db.insert(schema.vanDayReturns).values({ companyId, dayId: s.day.id, visitId: row?.visitId ?? '', orderId: made.orderId, counterReturnId: row?.counterReturnId ?? '', amount: '1', restock: true, createdBy: 'x' }))).toContain('van_day_returns_return_uidx');
    });
  });
});
