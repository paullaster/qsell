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
 * Selling from the van (database): a sale at a visit the rep has arrived at, paid now in the van's till shift or put on the customer's account,
 * issued from the van's own stock and nowhere else, at the server's prices, within what the rep's profile allows; a retry finds the sale it made;
 * the day's sales and takings are read from the sales tied to it; and the database refuses wrong values on its own.
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

describe.skipIf(url === undefined || url === '')('selling from the van (database)', () => {
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
    const [row] = await db.insert(schema.customers).values({ companyId, number: `SL${tag}${String(next())}`.toUpperCase(), name: name('Duka'), accountType: 'cash', ...over }).returning();
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
  }, 120_000);

  afterAll(async () => {
    await db.update(schema.vanDays).set({ status: 'cancelled', statusReason: 'Cleared after a test run' }).where(sql`${schema.vanDays.status} IN ('planned','loading','out','returning','reconciling')`);
    await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared after a test run' }).where(eq(schema.salesRoutes.status, 'active'));
    await db.update(schema.shifts).set({ status: 'closed', closedAt: new Date(), closedBy: 'test', declaredCash: '0', zNumber: `Z-SL-${tag}` }).where(sql`${schema.shifts.status} IN ('open','closing') AND ${schema.shifts.openedBy} IN (SELECT id::text FROM users WHERE email LIKE '%@sale.test')`).catch(() => undefined);
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
    await release();
  }, 120_000);

  describe('pricing', () => {
    it('works out the total at the server\'s prices for the customer, saving nothing', async () => {
      const s = await outDay();
      const priced = await c.vanSales.price(companyId, as(s.user), s.day.id, { visitId: s.v1?.id, kind: 'cash', lines: lines(s.p, 3) }, true);
      expect(priced).toMatchObject({ ok: true, total: 300, lines: [{ productId: s.p, quantity: 3, unitPrice: 100, lineTotal: 300 }] });
      expect((await at(s.p, s.van?.locationId ?? '')).n).toBe(20);
      expect((await c.vanSales.forDay(companyId, s.day.id)).rows).toEqual([]);
    });
  });

  describe('a cash sale', () => {
    it('is issued from the van, paid in the van\'s shift, tied to the day and visit, and counted in the day\'s sales', async () => {
      const s = await outDay();
      const made = await sell(s);
      expect(made).toMatchObject({ kind: 'cash', total: 200, changeDue: 0, customerName: s.a.name });
      expect(made.receiptNumber).not.toBeNull();
      expect(made.lines).toEqual([expect.objectContaining({ quantity: 2, unitPrice: 100, total: 200 })]);
      // The van gave it up; the warehouse was not touched.
      const van = await at(s.p, s.van?.locationId ?? '');
      expect(van.n - van.r).toBe(18);
      expect((await at(s.p, warehouse)).n).toBe(80);
      // It is the rep's sale, in the van's shift.
      const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, made.orderId));
      const [row] = await db.select().from(schema.vanDays).where(eq(schema.vanDays.id, s.day.id));
      expect(order).toMatchObject({ shiftId: row?.shiftId, salesModule: 'pos_cash_sale' });
      const sales = await c.vanSales.forDay(companyId, s.day.id);
      expect(sales.rows).toEqual([expect.objectContaining({ orderNumber: made.orderNumber, kind: 'cash', total: 200, visitId: s.v1?.id })]);
      expect(sales.totals).toEqual({ all: 200, cash: 200, mobileMoney: 0, card: 0, credit: 0 });
      const detail = await c.vanDays.find(companyId, s.day.id);
      expect(detail?.events.at(-1)).toMatchObject({ action: 'day.sale_made', words: 'A sale was made from the van' });
    });

    it('takes the stock from the van and nowhere else: more than the van holds is refused though the warehouse has plenty', async () => {
      const s = await outDay({ stock: 5 });
      await expect(sell(s, { lines: lines(s.p, 6), tenders: pay(600) })).rejects.toThrow(/Insufficient inventory/);
      expect((await at(s.p, warehouse)).n).toBe(95);
      expect((await at(s.p, s.van?.locationId ?? '')).n).toBe(5);
      expect((await c.vanSales.forDay(companyId, s.day.id)).rows).toEqual([]);
      const made = await sell(s, { lines: lines(s.p, 5), tenders: pay(500) });
      expect(made.total).toBe(500);
      expect((await at(s.p, warehouse)).n).toBe(95);
    });

    it('finds the sale it made when the same key is sent again, and sells nothing twice', async () => {
      const s = await outDay();
      const saleKey = randomUUID();
      const first = await sell(s, { saleKey });
      const again = await sell(s, { saleKey });
      expect(again.orderNumber).toBe(first.orderNumber);
      const van = await at(s.p, s.van?.locationId ?? '');
      expect(van.n - van.r).toBe(18);
      expect((await c.vanSales.forDay(companyId, s.day.id)).rows).toHaveLength(1);
      expect((await db.select().from(schema.vanDayOrders).where(eq(schema.vanDayOrders.orderId, first.orderId)))).toHaveLength(1);
    });

    it('is refused when the payment does not cover the total, before anything is held or saved', async () => {
      const s = await outDay();
      await expect(sell(s, { tenders: pay(150) })).rejects.toThrow();
      await expect(sell(s, { tenders: [{ methodId: randomUUID(), amount: 200, reference: '' }] })).rejects.toThrow('not available at this till');
      const van = await at(s.p, s.van?.locationId ?? '');
      expect(van.n - van.r).toBe(20);
      expect((await c.vanSales.forDay(companyId, s.day.id)).rows).toEqual([]);
    });

    it('gives change from the cash handed over', async () => {
      const s = await outDay();
      const made = await sell(s, { tenders: pay(500) });
      expect(made).toMatchObject({ total: 200, changeDue: 300 });
    });
  });

  describe('a sale on the customer\'s account', () => {
    it('is placed as a credit sale issued from the van, within the rep\'s credit limit for the day, and counted as credit', async () => {
      const s = await outDay({ limits: { maySellOnCredit: true, maxCreditPerDay: 500 } });
      await c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'no_sale', reason: 'Nothing wanted here' }, true);
      await c.vanRun.arrive(companyId, as(s.user), s.day.id, s.v2?.id ?? '', {}, true);
      const made = await c.vanSales.sell(companyId, as(s.user), s.day.id, { visitId: s.v2?.id, kind: 'credit', saleKey: randomUUID(), lines: lines(s.p, 2) }, true);
      expect(made).toMatchObject({ kind: 'credit', total: 200, customerName: s.b.name });
      const [order] = await db.select().from(schema.orders).where(eq(schema.orders.id, made.orderId));
      expect(order?.salesModule).toBe('credit_sale');
      const van = await at(s.p, s.van?.locationId ?? '');
      expect(van.n - van.r).toBe(18);
      expect((await at(s.p, warehouse)).n).toBe(80);
      expect((await c.vanSales.forDay(companyId, s.day.id)).totals).toEqual({ all: 200, cash: 0, mobileMoney: 0, card: 0, credit: 200 });
      // 200 of the 500 is given: another 300 fits, 301 does not.
      await expect(c.vanSales.sell(companyId, as(s.user), s.day.id, { visitId: s.v2?.id, kind: 'credit', saleKey: randomUUID(), lines: lines(s.p, 4) }, true)).rejects.toThrow('You may give KES 300.00 more credit today');
      const more = await c.vanSales.sell(companyId, as(s.user), s.day.id, { visitId: s.v2?.id, kind: 'credit', saleKey: randomUUID(), lines: lines(s.p, 3) }, true);
      expect(more.total).toBe(300);
      await expect(c.vanSales.sell(companyId, as(s.user), s.day.id, { visitId: s.v2?.id, kind: 'credit', saleKey: randomUUID(), lines: lines(s.p, 1) }, true)).rejects.toThrow('given all the credit you may today');
    });

    it('finds the sale it made when the same key is sent again', async () => {
      const s = await outDay({ limits: { maySellOnCredit: true, maxCreditPerDay: 0 } });
      await c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'no_sale', reason: 'Nothing wanted here' }, true);
      await c.vanRun.arrive(companyId, as(s.user), s.day.id, s.v2?.id ?? '', {}, true);
      const saleKey = randomUUID();
      const input = { visitId: s.v2?.id, kind: 'credit', saleKey, lines: lines(s.p, 1) };
      const first = await c.vanSales.sell(companyId, as(s.user), s.day.id, input, true);
      const again = await c.vanSales.sell(companyId, as(s.user), s.day.id, input, true);
      expect(again.orderNumber).toBe(first.orderNumber);
      expect((await c.vanSales.forDay(companyId, s.day.id)).rows).toHaveLength(1);
    });
  });

  describe('what a rep may do alone', () => {
    it('needs the right to change a price, to give a discount (within the limit) and to sell on credit', async () => {
      const s = await outDay();
      await expect(sell(s, { lines: lines(s.p, 1, { unitPrice: 80 }), tenders: pay(80) })).rejects.toThrow('not allowed to change a price');
      await expect(sell(s, { lines: lines(s.p, 1, { discount: { kind: 'percent', value: 2 } }), tenders: pay(98) })).rejects.toThrow('not allowed to give a discount');
      await expect(c.vanSales.sell(companyId, as(s.user), s.day.id, { visitId: s.v1?.id, kind: 'credit', saleKey: randomUUID(), lines: lines(s.p, 1) }, true)).rejects.toThrow('not allowed to sell on credit');
      const t = await outDay({ limits: { maxDiscountPercent: 5 } });
      await expect(sell(t, { lines: lines(t.p, 1, { discount: { kind: 'percent', value: 6 } }), tenders: pay(94) })).rejects.toThrow('at most 5% off');
      await expect(sell(t, { lines: lines(t.p, 1, { discount: { kind: 'amount', value: 5 } }), tenders: pay(95) })).rejects.toThrow('a percentage');
      expect((await c.vanSales.forDay(companyId, s.day.id)).rows).toEqual([]);
    });
  });

  describe('where and when a sale can be made', () => {
    it('is the day\'s rep, at a visit under way, while the day is out, from a van, to a customer who can be sold to', async () => {
      const s = await outDay({ arrive: false });
      await expect(sell(s)).rejects.toThrow(`Arrive at ${s.a.name} before selling to them`);
      await c.vanRun.arrive(companyId, as(s.user), s.day.id, s.v1?.id ?? '', {}, true);
      await expect(c.vanSales.sell(companyId, actor, s.day.id, { visitId: s.v1?.id, kind: 'cash', saleKey: randomUUID(), lines: lines(s.p, 1), tenders: pay(100) }, true)).rejects.toThrow('runs their own day');
      await expect(c.vanSales.sell(companyId, as(s.user), s.day.id, { visitId: s.v1?.id, kind: 'cash', saleKey: randomUUID(), lines: lines(s.p, 1), tenders: pay(100) }, false)).rejects.toThrow('not allowed to sell from a van');
      await expect(sell(s, {}, randomUUID())).rejects.toThrow('visit could not be found on this day');
      await expect(sell(s, { visitId: 'x' })).rejects.toThrow('Choose the visit');
      await expect(sell(s, { saleKey: 'nope' })).rejects.toThrow('told apart');
      await expect(sell(s, { lines: [] })).rejects.toThrow('Add something to sell');
      await db.update(schema.customers).set({ blocked: 'all' }).where(eq(schema.customers.id, s.a.id));
      await expect(sell(s)).rejects.toThrow('is blocked');
      await db.update(schema.customers).set({ blocked: 'none', isActive: false }).where(eq(schema.customers.id, s.a.id));
      await expect(sell(s)).rejects.toThrow('no longer in use');
      await db.update(schema.customers).set({ isActive: true }).where(eq(schema.customers.id, s.a.id));
      const pre = await outDay({ mode: 'pre_sell', arrive: false });
      await expect(c.vanSales.sell(companyId, as(pre.user), pre.day.id, { visitId: pre.v1?.id, kind: 'cash', saleKey: randomUUID(), lines: lines(pre.p, 1), tenders: pay(100) }, true)).rejects.toThrow('only takes orders');
      const early = await (async () => {
        const e = await outDay({ arrive: false });
        await db.update(schema.vanDays).set({ status: 'returning' }).where(eq(schema.vanDays.id, e.day.id));
        return e;
      })();
      await expect(c.vanSales.sell(companyId, as(early.user), early.day.id, { visitId: early.v1?.id, kind: 'cash', saleKey: randomUUID(), lines: lines(early.p, 1), tenders: pay(100) }, true)).rejects.toThrow('while the day is out on the route');
    });
  });

  describe('finishing a visit with sales', () => {
    it('is as sold, never as no sale, and a sold visit needs a sale', async () => {
      const s = await outDay();
      await expect(c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'sold' }, true)).rejects.toThrow('Nothing has been sold, ordered, delivered or collected at');
      await sell(s);
      await expect(c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'no_sale', reason: 'Changed my mind' }, true)).rejects.toThrow('sale, order, delivery or payment at');
      const done = await c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'sold' }, true);
      expect(done.visits[0]).toMatchObject({ status: 'done', outcome: 'sold', noSaleReason: null });
    });
  });

  describe('an order taken at a visit', () => {
    const order = async (s: Awaited<ReturnType<typeof outDay>>, over: Record<string, unknown> = {}, visitId = s.v1?.id) => await c.vanSales.order(companyId, as(s.user), s.day.id, { visitId, saleKey: randomUUID(), neededOn: '2026-12-15', lines: [{ productId: s.p, quantity: 4 }], ...over }, true);

    it('is an ordinary sales order priced by the server, with the stock held at the warehouse, tied to the day and the visit', async () => {
      const s = await outDay({ mode: 'pre_sell' });
      const priced = await c.vanSales.price(companyId, as(s.user), s.day.id, { visitId: s.v1?.id, kind: 'order', lines: lines(s.p, 4) }, true);
      expect(priced).toMatchObject({ ok: true, total: 400 });
      const made = await order(s);
      expect(made).toMatchObject({ total: 400, customerName: s.a.name, waitingForApproval: false });
      const [row] = await db.select().from(schema.orders).where(eq(schema.orders.orderNumber, made.orderNumber));
      expect(row).toMatchObject({ salesModule: 'sales_order', customerName: s.a.name });
      // Held at the warehouse for the delivery; nothing paid, nothing issued.
      const held = await at(s.p, warehouse);
      expect(held.r).toBeGreaterThanOrEqual(4);
      const sales = await c.vanSales.forDay(companyId, s.day.id);
      expect(sales.rows).toEqual([expect.objectContaining({ orderNumber: made.orderNumber, kind: 'order', total: 400, visitId: s.v1?.id })]);
      expect(sales).toMatchObject({ ordered: 400, totals: { all: 0, cash: 0, credit: 0 } });
      expect((await c.vanDays.find(companyId, s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.order_taken', words: 'An order was taken' });
    });

    it('finds the order it made when the same key is sent again, and holds the stock once', async () => {
      const s = await outDay({ mode: 'pre_sell' });
      const saleKey = randomUUID();
      const before = (await at(s.p, warehouse)).r;
      const first = await order(s, { saleKey });
      const again = await order(s, { saleKey });
      expect(again.orderNumber).toBe(first.orderNumber);
      expect((await at(s.p, warehouse)).r - before).toBe(4);
      expect((await c.vanSales.forDay(companyId, s.day.id)).rows).toHaveLength(1);
    });

    it('is finished as order taken, or as sold and ordered when something was also sold, and never as no sale', async () => {
      const s = await outDay({ mode: 'pre_sell' });
      await order(s);
      await expect(c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'no_sale', reason: 'Changed my mind' }, true)).rejects.toThrow('sale, order, delivery or payment at');
      expect((await c.vanRun.finish(companyId, as(s.user), s.day.id, s.v1?.id ?? '', { outcome: 'sold' }, true)).visits[0]).toMatchObject({ status: 'done', outcome: 'order_taken' });
      const both = await outDay({ mode: 'both' });
      await order(both);
      await sell(both);
      expect((await c.vanRun.finish(companyId, as(both.user), both.day.id, both.v1?.id ?? '', { outcome: 'sold' }, true)).visits[0]).toMatchObject({ outcome: 'sold_and_ordered' });
    });

    it('is refused on a day that only sells from the van, with no price or discount, past the stock, or before arriving', async () => {
      const vanOnly = await outDay({ mode: 'van_sell' });
      await expect(order(vanOnly)).rejects.toThrow('only sells from the van');
      const s = await outDay({ mode: 'pre_sell', arrive: false });
      await expect(order(s)).rejects.toThrow(`Arrive at ${s.a.name} before selling to them`);
      await c.vanRun.arrive(companyId, as(s.user), s.day.id, s.v1?.id ?? '', {}, true);
      await expect(order(s, { lines: [{ productId: s.p, quantity: 1, unitPrice: 5 }] })).rejects.toThrow('priced by the system');
      await expect(order(s, { neededOn: 'soon' })).rejects.toThrow('not a date');
      await expect(order(s, { lines: [{ productId: s.p, quantity: 5000 }] })).rejects.toThrow();
      await expect(c.vanSales.order(companyId, actor, s.day.id, { visitId: s.v1?.id, saleKey: randomUUID(), lines: [{ productId: s.p, quantity: 1 }] }, true)).rejects.toThrow('runs their own day');
      expect((await c.vanSales.forDay(companyId, s.day.id)).rows).toEqual([]);
    });
  });

  describe('stock taken from one place only', () => {
    it('can be asked of the reservation directly: from the van whatever channel, and never from another place', async () => {
      const s = await outDay();
      const van = s.van?.locationId ?? '';
      // The van's stock is no channel's: the shop cannot see it.
      expect(await c.stockAvailability.forProduct(s.p, 'ecommerce')).toMatchObject({ available: expect.any(Number) as number });
      const refId = `pin-${randomUUID()}`;
      const got = await c.stockReservations.reserve({ companyId, refType: 'test', refId, lines: [{ productId: s.p, quantity: 3 }], channel: 'ecommerce', fromLocationId: van, actor: 'tester' });
      expect(got).toMatchObject({ ok: true, reserved: [expect.objectContaining({ locationId: van, quantity: 3 })] });
      await c.stockReservations.release({ companyId, refType: 'test', refId, reason: 'test over', actor: 'tester' });
      // More than the van holds is short even though another place has it.
      const refused = await c.stockReservations.reserve({ companyId, refType: 'test', refId: `pin-${randomUUID()}`, lines: [{ productId: s.p, quantity: 50 }], channel: 'ecommerce', fromLocationId: van, actor: 'tester' });
      expect(refused.ok).toBe(false);
      // A place that is not in use is not a place to take from.
      const stopped = await c.stockLocations.create(companyId, { code: `SX${tag}${String(next())}`.toUpperCase().slice(0, 12), name: name('Stopped place'), kind: 'warehouse', branchId });
      await c.stockLocations.deactivate(companyId, stopped.id);
      const none = await c.stockReservations.reserve({ companyId, refType: 'test', refId: `pin-${randomUUID()}`, lines: [{ productId: s.p, quantity: 1 }], channel: 'pos_cash_sale', fromLocationId: stopped.id, actor: 'tester' });
      expect(none.ok).toBe(false);
    });
  });

  describe('held by the database itself', () => {
    it('refuses wrong values whichever way they arrive', async () => {
      const s = await outDay();
      const made = await sell(s);
      const bad = async (set: string) => await refusedBy(db.execute(sql.raw(`UPDATE van_day_orders SET ${set} WHERE order_id = '${made.orderId}'`)));
      expect(await bad("kind = 'barter'")).toContain('van_day_orders_kind_chk');
      expect(await bad('total = -1')).toContain('van_day_orders_total_chk');
      expect(await refusedBy(db.insert(schema.vanDayOrders).values({ companyId, dayId: s.day.id, visitId: s.v1?.id ?? '', orderId: made.orderId, kind: 'cash', total: '1', createdBy: 'x' }))).toContain('van_day_orders_order_uidx');
    });
  });
});
