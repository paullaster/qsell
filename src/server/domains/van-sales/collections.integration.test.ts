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
 * Collections at a visit (database): money a customer pays the rep against what they owe, as an ordinary receipt applied to their open
 * invoices, cash going into the van's till shift; a retry never takes it twice; and the database refusing wrong values on its own.
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

describe.skipIf(url === undefined || url === '')('collections from the van (database)', () => {
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
    const financeCtx = { companyId, actor, origin: { surface: 'test', action: 'setup' } };
    await c.finance.setup.applyTemplate(financeCtx, 'kenya', { fiscalYearStart: '2026-01-01' }).catch((error: unknown) => {
      if (!(error instanceof Error) || !error.message.includes('already has a chart')) throw error;
    });
    await c.finance.paymentMethods.seedStandard(financeCtx).catch(() => undefined);
    cashMethod = await makeMethod('cash', false);
    mpesaMethod = await makeMethod('mobile_money', true);
  }, 120_000);

  afterAll(async () => {
    await db.update(schema.vanDays).set({ status: 'cancelled', statusReason: 'Cleared after a test run' }).where(sql`${schema.vanDays.status} IN ('planned','loading','out','returning','reconciling')`);
    await db.update(schema.salesRoutes).set({ status: 'stopped', statusReason: 'Cleared after a test run' }).where(eq(schema.salesRoutes.status, 'active'));
    await db.update(schema.shifts).set({ status: 'closed', closedAt: new Date(), closedBy: 'test', declaredCash: '0', zNumber: `Z-SL-${tag}` }).where(sql`${schema.shifts.status} IN ('open','closing') AND ${schema.shifts.openedBy} IN (SELECT id::text FROM users WHERE email LIKE '%@sale.test')`).catch(() => undefined);
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
    await release();
  }, 120_000);


  let cashMethod = '';
  let mpesaMethod = '';
  const makeMethod = async (kind: 'cash' | 'mobile_money', requiresReference: boolean) => {
    const [existing] = await db.select({ id: schema.paymentProviderConfigs.id }).from(schema.paymentProviderConfigs).limit(1);
    const provider = existing ?? (await db.insert(schema.paymentProviderConfigs).values({ companyId, providerCode: 'manual', displayName: 'Manual', isSystem: true, isEnabled: true, apiBaseUrl: 'https://manual.invalid', environment: 'sandbox' } as never).returning({ id: schema.paymentProviderConfigs.id }))[0];
    const run = randomUUID().slice(0, 6).toUpperCase();
    const [bank] = await db.insert(schema.bankAccounts).values({ companyId, code: `CL${run}`, name: `Collections ${kind} ${run}`, kind: kind === 'cash' ? 'cash' : 'bank', currency: 'KES', createdBy: 'test' } as never).returning();
    const [gl] = await db.insert(schema.glAccounts).values({ companyId, no: `18${run}`, name: `Collections ${kind} ${run}`, type: 'posting', category: 'assets', normalBalance: 'debit' } as never).returning();
    const [method] = await db.insert(schema.paymentMethods).values({ companyId, providerId: provider?.id ?? '', code: `CL${run}`, name: `Collections ${kind} ${run}`, kind, requiresReference, balancingBankAccountId: bank?.id ?? '', glAccountId: gl?.id ?? '', usableFor: ['customer_receipt'], createdBy: 'test' } as never).returning();
    return method?.id ?? '';
  };
  /** An open invoice of the given amount on a customer's account, as a credit sale leaves one. */
  const invoice = async (customerId: string, amount: number, due: string) => {
    const entry = await c.finance.customerLedger.addEntry(db, { companyId, customerId, documentType: 'invoice', documentNo: `INV-${randomUUID().slice(0, 8)}`, amountCents: Math.round(amount * 100), currency: 'KES', postingDate: '2026-11-01', dueDate: new Date(`${due}T00:00:00Z`) });
    await db.update(schema.customers).set({ balance: String(amount) }).where(eq(schema.customers.id, customerId));
    return entry;
  };
  const openOf = async (customerId: string) => (await c.finance.customerLedger.openItems(companyId, customerId)).filter((e) => Number(e.remainingAmount) > 0);

  /** A day that is out with the van's till opened on a float, the rep at the first customer, who owes `owes`. */
  const outAtCustomer = async (over: { owes?: number; float?: number } = {}) => {
    const s = await plannedDay();
    const made = await load(s, [{ productId: s.p, quantity: 2 }]);
    await c.vanLoads.ship(companyId, actor, made?.id ?? '');
    await c.vanLoads.sign(companyId, as(s.user), made?.id ?? '', {}, { maySell: true, mayPlan: false });
    await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: over.float ?? 1000, expectedVersion: (await c.vanDays.find(companyId, s.day.id))?.day.version }, true);
    const visit = (await c.vanDays.find(companyId, s.day.id))?.visits.find((v) => v.customerName === s.a.name);
    await c.vanRun.arrive(companyId, as(s.user), s.day.id, visit?.id ?? '', {}, true);
    if (over.owes !== undefined) await invoice(s.a.id, over.owes, '2026-11-20');
    return { s, visit };
  };
  const collect = async (x: Awaited<ReturnType<typeof outAtCustomer>>, over: Record<string, unknown> = {}, user: { id: string } = x.s.user) => await c.vanCollections.collect(companyId, as(user), x.s.day.id, { visitId: x.visit?.id, methodId: cashMethod, amount: 500, reference: '', key: randomUUID(), ...over }, true);


  describe('collecting money at a visit', () => {
    it('is an ordinary receipt applied to the open invoices oldest first, with cash paid into the van\'s till', async () => {
      const x = await outAtCustomer({ owes: 1500 });
      const [before] = await c.vanCollections.owing(companyId, x.s.day.id);
      expect(before).toMatchObject({ customerName: x.s.a.name, total: 1500 });
      await collect(x, { amount: 600 });
      const open = await openOf(x.s.a.id);
      expect(open.map((e) => Number(e.remainingAmount))).toEqual([900]);
      const [row] = await c.vanCollections.forDay(companyId, x.s.day.id);
      expect(row).toMatchObject({ amount: 600, methodKind: 'cash', customerName: x.s.a.name });
      const [receipt] = await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.number, row?.receiptNumber ?? ''));
      expect(receipt).toMatchObject({ status: 'posted', amount: '600.00', source: 'pos', customerId: x.s.a.id });
      // The cash is in the van's till: the float and the collection.
      expect((await c.vanCash.forDay(companyId, x.s.day.id))?.cash).toBe(1600);
      const [link] = await db.select().from(schema.vanDayCollections).where(eq(schema.vanDayCollections.dayId, x.s.day.id));
      const [move] = await db.select().from(schema.shiftMovements).where(eq(schema.shiftMovements.id, link?.movementId ?? ''));
      expect(move).toMatchObject({ kind: 'paid_in', amount: '600.00' });
      expect(move?.reason).toContain(row?.receiptNumber ?? '?');
      expect((await c.vanDays.find(companyId, x.s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.collected', words: 'Money was collected from a customer' });
      expect((await c.vanCollections.owing(companyId, x.s.day.id))[0]).toMatchObject({ total: 900 });
    });

    it('takes M-Pesa without touching the till, and asks for its code', async () => {
      const x = await outAtCustomer({ owes: 1000 });
      await expect(collect(x, { methodId: mpesaMethod, amount: 400 })).rejects.toThrow('needs its reference');
      await collect(x, { methodId: mpesaMethod, amount: 400, reference: `QK${randomUUID().slice(0, 8).toUpperCase()}` });
      const [row] = await c.vanCollections.forDay(companyId, x.s.day.id);
      expect(row).toMatchObject({ amount: 400, methodKind: 'mobile_money' });
      expect((await c.vanCash.forDay(companyId, x.s.day.id))?.cash).toBe(1000);
      expect((await db.select().from(schema.vanDayCollections).where(eq(schema.vanDayCollections.dayId, x.s.day.id)))[0]?.movementId).toBeNull();
      expect((await openOf(x.s.a.id)).map((e) => Number(e.remainingAmount))).toEqual([600]);
    });

    it('finds the payment it made when the same key is sent again, and takes the money once', async () => {
      const x = await outAtCustomer({ owes: 1000 });
      const key = randomUUID();
      await collect(x, { amount: 300, key });
      await collect(x, { amount: 300, key });
      expect(await c.vanCollections.forDay(companyId, x.s.day.id)).toHaveLength(1);
      expect((await openOf(x.s.a.id)).map((e) => Number(e.remainingAmount))).toEqual([700]);
      expect((await c.vanCash.forDay(companyId, x.s.day.id))?.cash).toBe(1300);
      expect((await db.select().from(schema.customerReceipts).where(eq(schema.customerReceipts.customerId, x.s.a.id)))).toHaveLength(1);
    });

    it('is refused for more than is owed, a customer who owes nothing, before arriving, by another person, for a way of paying that is not there, and a bad amount', async () => {
      const x = await outAtCustomer({ owes: 500 });
      await expect(collect(x, { amount: 500.01 })).rejects.toThrow('cannot collect more');
      await expect(collect(x, { amount: 0 })).rejects.toThrow('how much the customer paid');
      await expect(collect(x, { methodId: randomUUID() })).rejects.toThrow('not available here');
      await expect(collect(x, { key: 'x' })).rejects.toThrow('told apart');
      await expect(collect(x, {}, await person())).rejects.toThrow('runs their own day');
      await expect(c.vanCollections.collect(companyId, as(x.s.user), x.s.day.id, { visitId: x.visit?.id, methodId: cashMethod, amount: 5, key: randomUUID() }, false)).rejects.toThrow('not allowed to sell from a van');
      const none = await outAtCustomer();
      await expect(collect(none, { amount: 10 })).rejects.toThrow('owes nothing');
      const early = await outAtCustomer({ owes: 100 });
      await db.update(schema.vanVisits).set({ status: 'planned' }).where(eq(schema.vanVisits.id, early.visit?.id ?? ''));
      await expect(collect(early, { amount: 10 })).rejects.toThrow('Arrive at');
      expect(await c.vanCollections.forDay(companyId, x.s.day.id)).toEqual([]);
      expect((await openOf(x.s.a.id)).map((e) => Number(e.remainingAmount))).toEqual([500]);
    });
  });

  describe('finishing the visit', () => {
    it('is as collected only when money was the only thing done, and never as no sale', async () => {
      const x = await outAtCustomer({ owes: 700 });
      await expect(c.vanRun.finish(companyId, as(x.s.user), x.s.day.id, x.visit?.id ?? '', { outcome: 'sold' }, true)).rejects.toThrow('Nothing has been sold, ordered, delivered, collected or returned at');
      await collect(x, { amount: 200 });
      await expect(c.vanRun.finish(companyId, as(x.s.user), x.s.day.id, x.visit?.id ?? '', { outcome: 'no_sale', reason: 'Nothing wanted' }, true)).rejects.toThrow('payment or return at');
      const done = await c.vanRun.finish(companyId, as(x.s.user), x.s.day.id, x.visit?.id ?? '', { outcome: 'sold' }, true);
      expect(done.visits.find((v) => v.id === x.visit?.id)).toMatchObject({ status: 'done', outcome: 'collected_only' });
    });
  });

  describe('held by the database itself', () => {
    it('refuses wrong values, cash without its movement, a card with one, and a second collection for one receipt', async () => {
      const x = await outAtCustomer({ owes: 800 });
      await collect(x, { amount: 100 });
      const [row] = await db.select().from(schema.vanDayCollections).where(eq(schema.vanDayCollections.dayId, x.s.day.id));
      const bad = async (set: string) => await refusedBy(db.execute(sql.raw(`UPDATE van_day_collections SET ${set} WHERE id = '${row?.id ?? ''}'`)));
      expect(await bad('amount = 0')).toContain('van_day_collections_amount_chk');
      expect(await bad("method_kind = 'barter', movement_id = NULL")).toContain('van_day_collections_kind_chk');
      expect(await bad('movement_id = NULL')).toContain('van_day_collections_cash_chk');
      expect(await bad("method_kind = 'card'")).toContain('van_day_collections_cash_chk');
      expect(await refusedBy(db.insert(schema.vanDayCollections).values({ companyId, dayId: x.s.day.id, visitId: row?.visitId ?? '', receiptId: row?.receiptId ?? '', amount: '1', methodKind: 'mobile_money', createdBy: 'x' }))).toContain('van_day_collections_receipt_uidx');
    });
  });
});
