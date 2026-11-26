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
 * Settling the day (database): the shortages found at the unload are decided (written off, and by the company's rule charged to the rep, with a manager
 * for a large one), the van's till is counted and closed, and the day is closed.
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

describe.skipIf(url === undefined || url === '')('settling the day (database)', () => {
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

  /** A day being counted: out with 10 on the van and nothing counted into the till, back, unloaded, received with `short` missing, and the office settling it. */
  const settling = async (over: { short?: number; float?: number } = {}) => {
    const x = await outDay();
    await skipAll(x);
    await back(x);
    const unload = (await c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true)).find((l) => l.kind === 'unload');
    const short = over.short ?? 0;
    await c.vanLoads.receive(companyId, actor, unload?.id ?? '', short === 0 ? {} : { entries: [{ productId: x.s.p, quantity: 10 - short }] }, true);
    await c.vanLoads.startReconciling(companyId, actor, x.s.day.id, true);
    return x;
  };
  const view = async (x: { s: Planned }) => await c.vanSettle.view(companyId, x.s.day.id);
  const decide = async (x: { s: Planned }, id: string, over: Record<string, unknown> = {}, perms = { mayReconcile: true, mayApprove: false }, user: Actor = actor) => await c.vanSettle.decide(companyId, user, x.s.day.id, id, { reason: 'A case was broken on the road', ...over }, perms);
  const till = async (x: { s: Planned }, counted: unknown, reason = '', perms = { mayClose: true, supervisor: false }, user: { id: string } = x.s.user) => await c.vanSettle.closeTill(companyId, as(user), x.s.day.id, { counted, reason }, perms);
  const setRule = async (rule: 'charge_rep' | 'write_off') => {
    const now = await c.vanSalesSettings.screen(companyId);
    await c.vanSalesSettings.save(companyId, actor, { ...now.settings, shortage: rule }, now.version, reason);
  };

  describe('shortages', () => {
    it('are found at the unload, worth what the stock cost, and left in transit until they are decided', async () => {
      const x = await settling({ short: 3 });
      const v = await view(x);
      expect(v.shortages).toEqual([expect.objectContaining({ productName: expect.any(String) as string, quantity: 3, value: 150, rule: 'charge_rep', needsApproval: false, decided: false })]);
      expect(v.undecided).toBe(1);
      expect(v.closeProblem).toBe('1 shortage is still to be decided.');
      const unload = (await c.vanLoads.list(companyId, x.s.day.id)).find((l) => l.kind === 'unload');
      expect(unload?.lines[0]).toMatchObject({ received: 7, inTransit: 3 });
    });

    it('are written off with the reason and, by the company\'s rule, charged to the rep', async () => {
      const x = await settling({ short: 3 });
      const id = (await view(x)).shortages[0]?.id ?? '';
      await expect(decide(x, id, { reason: 'no' })).rejects.toThrow('Say why');
      await expect(decide(x, id, {}, { mayReconcile: false, mayApprove: false })).rejects.toThrow('not allowed to settle');
      await expect(decide(x, id, {}, { mayReconcile: true, mayApprove: false }, as(x.s.user))).rejects.toThrow('does not decide');
      await decide(x, id);
      const v = await view(x);
      expect(v.shortages[0]).toMatchObject({ decided: true, decision: 'charge_rep', reason: 'A case was broken on the road', chargedAmount: 150 });
      expect(v.undecided).toBe(0);
      const [row] = await db.select().from(schema.vanDayShortages).where(eq(schema.vanDayShortages.id, id));
      expect(row).toMatchObject({ chargedRepId: x.s.rep.id, chargedAmount: '150.00' });
      expect((await c.vanLoads.list(companyId, x.s.day.id)).find((l) => l.kind === 'unload')?.lines[0]).toMatchObject({ inTransit: 0 });
      expect((await c.vanDays.find(companyId, x.s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.shortage_decided', words: 'A shortage was decided' });
      await expect(decide(x, id)).rejects.toThrow('already been decided');
    });

    it('are only written off, with no charge, when the company\'s rule says so', async () => {
      await setRule('write_off');
      try {
        const x = await settling({ short: 2 });
        const id = (await view(x)).shortages[0]?.id ?? '';
        expect((await view(x)).rule).toBe('write_off');
        await decide(x, id);
        const [row] = await db.select().from(schema.vanDayShortages).where(eq(schema.vanDayShortages.id, id));
        expect(row).toMatchObject({ decision: 'write_off', chargedRepId: null, chargedAmount: null });
      } finally {
        await setRule('charge_rep');
      }
    });

    it('are decided by a manager when worth more than the company\'s limit', async () => {
      const x = await settling({ short: 10 });
      const [s] = (await view(x)).shortages;
      expect(s).toMatchObject({ value: 500, needsApproval: false });
      await db.update(schema.vanDayShortages).set({ needsApproval: true, value: '1500.00' }).where(eq(schema.vanDayShortages.id, s?.id ?? ''));
      await expect(decide(x, s?.id ?? '')).rejects.toThrow('a manager decides it');
      await decide(x, s?.id ?? '', {}, { mayReconcile: true, mayApprove: true });
      expect((await view(x)).shortages[0]).toMatchObject({ decided: true, chargedAmount: 1500 });
    });

    it('are decided only while the day is being counted', async () => {
      const x = await outDay();
      await skipAll(x);
      await back(x);
      const unload = (await c.vanLoads.unload(companyId, as(x.s.user), x.s.day.id, true)).find((l) => l.kind === 'unload');
      await c.vanLoads.receive(companyId, actor, unload?.id ?? '', { entries: [{ productId: x.s.p, quantity: 8 }] }, true);
      const id = (await view(x)).shortages[0]?.id ?? '';
      await expect(decide(x, id)).rejects.toThrow('while the day is being counted');
    });
  });

  describe('the van\'s till', () => {
    it('is counted and closed through the till\'s own close, once, by the rep or a supervisor', async () => {
      const x = await settling();
      await expect(till(x, 0, '', { mayClose: false, supervisor: false })).rejects.toThrow('not allowed to close a till');
      await expect(till(x, 'lots')).rejects.toThrow('how much cash');
      await expect(till(x, 400)).rejects.toThrow();
      expect((await view(x)).till.status).toBe('open');
      const closed = await till(x, 0);
      expect(closed).toMatchObject({ variance: 0, pending: false });
      expect(closed.zNumber).not.toBeNull();
      const v = await view(x);
      expect(v.till).toMatchObject({ status: 'closed', zNumber: closed.zNumber, variance: 0 });
      expect(v.tillProblem).toBe('The till is already closed.');
      await expect(till(x, 0)).rejects.toThrow('already closed');
      expect((await c.vanDays.find(companyId, x.s.day.id))?.events.at(-1)).toMatchObject({ action: 'day.till_closed', words: 'The till was counted and closed' });
    });

    it('is counted while the day is being counted, not before', async () => {
      const x = await outDay();
      await expect(till(x, 0)).rejects.toThrow('while the day is being counted');
    });
  });

  describe('closing the day', () => {
    it('needs every shortage decided and the till closed, and is for the office', async () => {
      const x = await settling({ short: 3 });
      await expect(c.vanSettle.closeDay(companyId, actor, x.s.day.id, false)).rejects.toThrow('not allowed to settle');
      await expect(c.vanSettle.closeDay(companyId, actor, x.s.day.id, true)).rejects.toThrow('still to be decided');
      await decide(x, (await view(x)).shortages[0]?.id ?? '');
      await expect(c.vanSettle.closeDay(companyId, actor, x.s.day.id, true)).rejects.toThrow('not been counted and closed');
      await till(x, 0);
      expect((await view(x)).closeProblem).toBeNull();
      await c.vanSettle.closeDay(companyId, actor, x.s.day.id, true);
      const found = await c.vanDays.find(companyId, x.s.day.id);
      expect(found?.day.status).toBe('closed');
      expect(found?.events.at(-1)).toMatchObject({ action: 'day.closed', words: 'The day was closed', fromStatus: 'reconciling', toStatus: 'closed' });
      await expect(c.vanSettle.closeDay(companyId, actor, x.s.day.id, true)).rejects.toThrow('being counted can be closed');
    });

    it('closes a day that only takes orders, with no van and no till', async () => {
      const s = await plannedDay({ mode: 'pre_sell' });
      await c.vanRun.sendOut(companyId, as(s.user), s.day.id, { float: 0, expectedVersion: (await c.vanDays.find(companyId, s.day.id))?.day.version }, true);
      for (const v of (await c.vanDays.find(companyId, s.day.id))?.visits ?? []) await c.vanRun.skip(companyId, as(s.user), s.day.id, v.id, 'Not visited today', true);
      await c.vanRun.comeBack(companyId, as(s.user), s.day.id, { expectedVersion: (await c.vanDays.find(companyId, s.day.id))?.day.version }, true);
      await c.vanLoads.startReconciling(companyId, actor, s.day.id, true);
      expect((await c.vanSettle.view(companyId, s.day.id)).till.status).toBeNull();
      await c.vanSettle.closeDay(companyId, actor, s.day.id, true);
      expect((await c.vanDays.find(companyId, s.day.id))?.day.status).toBe('closed');
    });
  });

  describe('held by the database itself', () => {
    it('refuses wrong values and half a decision', async () => {
      const x = await settling({ short: 2 });
      const [row] = await db.select().from(schema.vanDayShortages).where(eq(schema.vanDayShortages.dayId, x.s.day.id));
      const bad = async (set: string) => await refusedBy(db.execute(sql.raw(`UPDATE van_day_shortages SET ${set} WHERE id = '${row?.id ?? ''}'`)));
      expect(await bad("quantity = 0")).toContain('van_day_shortages_quantity_chk');
      expect(await bad("rule = 'ignore'")).toContain('van_day_shortages_rule_chk');
      expect(await bad("decision = 'forgive', decided_by = 'x', decided_at = now(), reason = 'x'")).toContain('van_day_shortages_decision_chk');
      expect(await bad("decision = 'write_off'")).toContain('van_day_shortages_decided_chk');
      expect(await bad("decision = 'charge_rep', decided_by = 'x', decided_at = now(), reason = 'abc'")).toContain('van_day_shortages_charge_chk');
      expect(await refusedBy(db.insert(schema.vanDayShortages).values({ companyId, dayId: x.s.day.id, loadId: row?.loadId ?? '', productId: row?.productId ?? '', lineId: row?.lineId ?? '', quantity: '1', unitCost: '1', value: '1', rule: 'write_off' }))).toContain('van_day_shortages_line_uidx');
    });
  });
});
