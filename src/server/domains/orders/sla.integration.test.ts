import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import { DEFAULT_TARGETS, type StageTarget } from '@/lib/order-sla';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as StagesModule from './stages';
import type * as ServiceModule from './sla-service';
import type * as ReadModule from './timeline-read';
import type { OrderSlaNotifier } from './sla-notifier';
import type { OrderWriteService as OrderWriteServiceType } from './write-service';

/**
 * The order targets against a real database: a late order is recorded once however often (or however many times at once) the
 * sweep runs, escalated once, closed with its true end time when the order moves on, and never recorded for a stage that is off.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const MIN = 60_000;

describe.skipIf(!has(url))('order targets and late orders (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let Stages: typeof StagesModule.OrderStages;
  let Service: typeof ServiceModule.OrderSlaService;
  let read: typeof ReadModule;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let companyId: string;
  let branchId: string;
  let productId: string;
  let sla: ServiceModule.OrderSlaService;

  const place = async () => {
    const result = await createOrder({
      branchId,
      orderNumber: `SLA-${randomUUID()}`,
      customerName: 'Late Buyer',
      customerEmail: `sla-${randomUUID()}@late.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: 1 }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
    });
    expect(result.success, result.error).toBe(true);
    return result.order?.id ?? '';
  };
  /** An order in "payment started", and the instant it got there. */
  const waiting = async () => {
    const id = await place();
    await Stages.move(db, id, 'payment_started', 'entered', { ref: { type: 'payment_attempt', id: randomUUID() }, attemptNo: 1 });
    const [o] = await db.select().from(schema.orders).where(eq(schema.orders.id, id));
    return { id, since: o?.currentStageSince ?? new Date() };
  };
  const breaches = async (orderId: string) => await db.select().from(schema.orderSlaBreaches).where(eq(schema.orderSlaBreaches.orderId, orderId));
  const target = (over: Partial<StageTarget> = {}): StageTarget[] => [{ stage: 'payment_started', targetMinutes: 30, escalateAfterMinutes: 15, enabled: true, ...over }];
  const useTarget = async (over: Partial<StageTarget> = {}) => {
    await sla.save(companyId, 'tester', target(over), [], []);
  };
  const reset = async () => {
    await db.delete(schema.orderStageTargets).where(eq(schema.orderStageTargets.companyId, companyId));
    await db.delete(schema.orderSlaSettings).where(eq(schema.orderSlaSettings.companyId, companyId));
  };

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ OrderStages: Stages } = await import('./stages'));
    ({ OrderSlaService: Service } = await import('./sla-service'));
    read = await import('./timeline-read');
    const writer = (await import('./write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    sla = c.orderSla;
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'SLA Test Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const itemTypeId = `it_sla_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_sla_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `SLA-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `SLAS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Late product', slug: `sla-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50', stockQuantity: 100000, taxRate: '0', isTaxInclusive: true });
    await reset();
  });
  afterAll(reset);

  describe('the settings', () => {
    it('start as the defaults, and an override replaces one stage only', async () => {
      await reset();
      const before = await sla.settings(companyId);
      expect(before.targets).toEqual([...DEFAULT_TARGETS]);
      expect(before).toMatchObject({ raiseEmails: [], escalateEmails: [] });
      await useTarget({ targetMinutes: 12, escalateAfterMinutes: 7 });
      const after = await sla.settings(companyId);
      expect(after.targets.find((t) => t.stage === 'payment_started')).toMatchObject({ targetMinutes: 12, escalateAfterMinutes: 7 });
      expect(after.targets.find((t) => t.stage === 'dispatched')).toMatchObject({ targetMinutes: 72 * 60 });
      await reset();
    });

    it('save the two address lists with the targets, or nothing at all', async () => {
      await sla.save(companyId, 'tester', target(), ['ops@shop.co.ke'], ['boss@shop.co.ke']);
      expect(await sla.settings(companyId)).toMatchObject({ raiseEmails: ['ops@shop.co.ke'], escalateEmails: ['boss@shop.co.ke'] });
      const bad = [...target(), { stage: 'packed', targetMinutes: 1, escalateAfterMinutes: 15, enabled: true } as StageTarget];
      await expect(sla.save(companyId, 'tester', bad, [], [])).rejects.toThrow();
      expect((await sla.settings(companyId)).raiseEmails).toEqual(['ops@shop.co.ke']);
      expect((await sla.settings(companyId)).targets.find((t) => t.stage === 'packed')?.targetMinutes).not.toBe(1);
      await reset();
    });

    it('refuse a stage twice and a stage that is not a waiting stage, and the database refuses an out-of-range value on its own', async () => {
      await expect(sla.save(companyId, 'tester', [...target(), ...target()], [], [])).rejects.toMatchObject({ code: 'DUPLICATE_STAGE' });
      await expect(sla.save(companyId, 'tester', [{ stage: 'completed' as StageTarget['stage'], targetMinutes: 30, escalateAfterMinutes: 15, enabled: true }], [], [])).rejects.toMatchObject({ code: 'BAD_STAGE' });
      await expect(db.insert(schema.orderStageTargets).values({ companyId, stage: 'packed', targetMinutes: 1, escalateAfterMinutes: 15 })).rejects.toThrow();
      await expect(db.insert(schema.orderStageTargets).values({ companyId, stage: 'packed', targetMinutes: 30, escalateAfterMinutes: 999999 })).rejects.toThrow();
    });
  });

  describe('raising', () => {
    it('records nothing before the target and one breach from it, with the wait it began and the targets in force', async () => {
      await useTarget();
      const { id, since } = await waiting();
      await sla.sweep(companyId, new Date(since.getTime() + 29 * MIN));
      expect(await breaches(id)).toEqual([]);
      await sla.sweep(companyId, new Date(since.getTime() + 31 * MIN));
      const [b, ...rest] = await breaches(id);
      expect(rest).toEqual([]);
      expect(b).toMatchObject({ stage: 'payment_started', targetMinutes: 30, escalateAfterMinutes: 15, escalatedAt: null, resolvedAt: null, acknowledgedAt: null });
      // The database keeps microseconds; a JavaScript date keeps milliseconds.
      expect(Math.abs((b?.enteredAt.getTime() ?? 0) - since.getTime())).toBeLessThan(2);
      expect(b?.companyId).toBe(companyId);
    });

    it('records a wait once however often the sweep runs, and however many sweeps run at the same time', async () => {
      await useTarget();
      const { id, since } = await waiting();
      const at = new Date(since.getTime() + 40 * MIN);
      await Promise.all([sla.sweep(companyId, at), sla.sweep(companyId, at), sla.sweep(companyId, at), sla.sweep(companyId, at)]);
      await sla.sweep(companyId, new Date(at.getTime() + MIN));
      expect(await breaches(id)).toHaveLength(1);
    });

    it('never records a stage that is switched off', async () => {
      await useTarget({ enabled: false });
      const { id, since } = await waiting();
      await sla.sweep(companyId, new Date(since.getTime() + 100_000 * MIN));
      expect(await breaches(id)).toEqual([]);
    });

    it('does not record an order that has left the stage', async () => {
      await useTarget();
      const { id, since } = await waiting();
      await Stages.move(db, id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: randomUUID() }, attemptNo: 1 });
      await sla.sweep(companyId, new Date(since.getTime() + 600 * MIN));
      expect((await breaches(id)).filter((b) => b.stage === 'payment_started')).toEqual([]);
    });

    it('mails one digest per sweep to the raise list, naming the orders that were just recorded', async () => {
      await sla.save(companyId, 'tester', target(), ['ops@shop.co.ke'], ['boss@shop.co.ke']);
      const sent: { level: string; numbers: string[]; to: readonly string[] }[] = [];
      const spy = { send: (level: string, list: readonly { orderNumber: string }[], to: readonly string[]) => { sent.push({ level, numbers: list.map((o) => o.orderNumber), to }); return Promise.resolve(); } } as unknown as OrderSlaNotifier;
      const mailing = new Service(db, spy);
      const a = await waiting();
      const b = await waiting();
      const [oa] = await db.select({ n: schema.orders.orderNumber }).from(schema.orders).where(eq(schema.orders.id, a.id));
      const [ob] = await db.select({ n: schema.orders.orderNumber }).from(schema.orders).where(eq(schema.orders.id, b.id));
      const at = new Date(Math.max(a.since.getTime(), b.since.getTime()) + 31 * MIN);
      await mailing.sweep(companyId, at);
      const raised = sent.filter((m) => m.level === 'raised');
      expect(raised).toHaveLength(1);
      expect(raised[0]?.to).toEqual(['ops@shop.co.ke']);
      expect(raised[0]?.numbers).toEqual(expect.arrayContaining([oa?.n, ob?.n]));
      sent.length = 0;
      await mailing.sweep(companyId, new Date(at.getTime() + MIN));
      expect(sent.filter((m) => m.level === 'raised')).toEqual([]);
    });
  });

  describe('escalating', () => {
    it('escalates once, after the escalation time from the moment it was raised, to the escalation list', async () => {
      await sla.save(companyId, 'tester', target({ targetMinutes: 30, escalateAfterMinutes: 15 }), ['ops@shop.co.ke'], ['boss@shop.co.ke']);
      const sent: { level: string; to: readonly string[] }[] = [];
      const spy = { send: (level: string, _l: unknown, to: readonly string[]) => { sent.push({ level, to }); return Promise.resolve(); } } as unknown as OrderSlaNotifier;
      const mailing = new Service(db, spy);
      const { id, since } = await waiting();
      const raisedAt = new Date(since.getTime() + 31 * MIN);
      await mailing.sweep(companyId, raisedAt);
      await mailing.sweep(companyId, new Date(raisedAt.getTime() + 14 * MIN));
      expect((await breaches(id))[0]?.escalatedAt).toBeNull();
      const escalateAt = new Date(raisedAt.getTime() + 15 * MIN);
      await mailing.sweep(companyId, escalateAt);
      const [b] = await breaches(id);
      expect(b?.escalatedAt?.getTime()).toBe(escalateAt.getTime());
      expect(sent.filter((m) => m.level === 'escalated').some((m) => m.to.includes('boss@shop.co.ke'))).toBe(true);
      sent.length = 0;
      await mailing.sweep(companyId, new Date(escalateAt.getTime() + 60 * MIN));
      expect(sent.filter((m) => m.level === 'escalated')).toEqual([]);
      expect((await breaches(id))[0]?.escalatedAt?.getTime()).toBe(escalateAt.getTime());
    });
  });

  describe('resolving', () => {
    it('closes a breach at the time of the event that moved the order on, so it keeps its true duration', async () => {
      await useTarget();
      const { id, since } = await waiting();
      await sla.sweep(companyId, new Date(since.getTime() + 45 * MIN));
      expect((await breaches(id))[0]?.resolvedAt).toBeNull();
      const moved = await Stages.move(db, id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: randomUUID() }, attemptNo: 1 });
      expect(moved.recorded).toBe(true);
      await sla.sweep(companyId, new Date(since.getTime() + 50 * MIN));
      const [b] = await breaches(id);
      const events = await Stages.timeline(db, id);
      const confirmed = events.find((e) => e.stage === 'payment_confirmed');
      expect(b?.resolvedAt?.getTime()).toBe(confirmed?.occurredAt.getTime());
      const open = await sla.open(companyId, null, new Date());
      expect(open.rows.some((r) => r.orderId === id)).toBe(false);
    });

    it('treats a second visit to the same stage as a new wait', async () => {
      await useTarget();
      const { id, since } = await waiting();
      await sla.sweep(companyId, new Date(since.getTime() + 31 * MIN));
      await Stages.move(db, id, 'payment_failed', 'failed', { ref: { type: 'payment_attempt', id: randomUUID() }, attemptNo: 1, reasonCode: 'declined' });
      await Stages.move(db, id, 'payment_started', 'entered', { ref: { type: 'payment_attempt', id: randomUUID() }, attemptNo: 2 });
      const [o] = await db.select().from(schema.orders).where(eq(schema.orders.id, id));
      await sla.sweep(companyId, new Date((o?.currentStageSince ?? new Date()).getTime() + 31 * MIN));
      const all = await breaches(id);
      expect(all).toHaveLength(2);
      expect(all.filter((b) => b.resolvedAt === null)).toHaveLength(1);
    });
  });

  describe('the list and acknowledging', () => {
    it('lists open breaches oldest first, a page at a time, without repeats', async () => {
      await useTarget();
      const made = [await waiting(), await waiting(), await waiting()];
      const last = Math.max(...made.map((m) => m.since.getTime()));
      const t = new Date(last + 31 * MIN);
      await sla.sweep(companyId, t);
      const first = await sla.open(companyId, null, t, 2);
      expect(first.rows).toHaveLength(2);
      expect(first.nextCursor).not.toBeNull();
      const seen = new Set(first.rows.map((r) => r.id));
      let cursor = first.nextCursor;
      while (cursor !== null) {
        const page = await sla.open(companyId, cursor, t, 2);
        for (const r of page.rows) {
          expect(seen.has(r.id), 'a row repeated').toBe(false);
          seen.add(r.id);
        }
        cursor = page.nextCursor;
      }
      const all = await sla.open(companyId, null, t, 1000);
      const times = all.rows.map((r) => r.raisedAt);
      expect(times).toEqual([...times].sort());
      for (const m of made) expect(all.rows.some((r) => r.orderId === m.id)).toBe(true);
      expect(all.rows.find((r) => r.orderId === made[0]?.id)?.waitedMinutes).toBeGreaterThanOrEqual(31);
    });

    it('lets the first acknowledgement stand, refuses one on a closed breach, and never crosses companies', async () => {
      await useTarget();
      const { id, since } = await waiting();
      const t = new Date(since.getTime() + 31 * MIN);
      await sla.sweep(companyId, t);
      const [b] = await breaches(id);
      const breachId = b?.id ?? '';
      await sla.acknowledge(companyId, 'alice', breachId, '  Calling the shopper  ');
      await sla.acknowledge(companyId, 'bob', breachId, 'second');
      const [after] = await breaches(id);
      expect(after).toMatchObject({ acknowledgedBy: 'alice', note: 'Calling the shopper' });
      await expect(sla.acknowledge(randomUUID(), 'eve', breachId, '')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(sla.acknowledge(companyId, 'alice', randomUUID(), '')).rejects.toMatchObject({ code: 'NOT_FOUND' });
      await expect(sla.acknowledge(companyId, 'alice', breachId, 'x'.repeat(501))).rejects.toMatchObject({ code: 'NOTE_TOO_LONG' });
      await Stages.move(db, id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: randomUUID() }, attemptNo: 1 });
      await sla.sweep(companyId, t);
      const second = await waiting();
      await sla.sweep(companyId, new Date(second.since.getTime() + 31 * MIN));
      const [sb] = await breaches(second.id);
      await Stages.move(db, second.id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: randomUUID() }, attemptNo: 1 });
      await sla.sweep(companyId, new Date(second.since.getTime() + 60 * MIN));
      await expect(sla.acknowledge(companyId, 'alice', sb?.id ?? '', '')).rejects.toMatchObject({ code: 'RESOLVED' });
    });
  });

  describe('keeping the records', () => {
    it('removes resolved records older than the retention and never an open one', async () => {
      const oldOrder = await place();
      const openOrder = await place();
      const long = new Date(Date.now() - 14 * 31 * 86_400_000);
      const stamp = new Date(long.getTime() - 1000);
      await db.insert(schema.orderSlaBreaches).values([
        { companyId, orderId: oldOrder, stage: 'packed', enteredAt: stamp, targetMinutes: 30, escalateAfterMinutes: 15, resolvedAt: long },
        { companyId, orderId: openOrder, stage: 'packed', enteredAt: stamp, targetMinutes: 30, escalateAfterMinutes: 15, resolvedAt: null },
      ]);
      expect(await sla.purge(new Date())).toBeGreaterThanOrEqual(1);
      expect(await breaches(oldOrder)).toEqual([]);
      expect(await breaches(openOrder)).toHaveLength(1);
    });
  });

  describe('the order flow screen', () => {
    it('lists stuck orders by the targets in force: an order that is not late yet is absent, a stage that is off is ignored', async () => {
      await useTarget({ targetMinutes: 30 });
      const { id, since } = await waiting();
      const targets = (await sla.settings(companyId)).targets;
      const soon = await read.orderFlow(db, 7, new Date(since.getTime() + 20 * MIN), targets);
      expect(soon.stuck.some((s) => s.orderId === id)).toBe(false);
      const late = await read.orderFlow(db, 7, new Date(since.getTime() + 31 * MIN), targets);
      expect(late.stuck.some((s) => s.orderId === id)).toBe(true);
      await useTarget({ enabled: false });
      const off = await read.orderFlow(db, 7, new Date(since.getTime() + 31 * MIN), (await sla.settings(companyId)).targets);
      expect(off.stuck.some((s) => s.orderId === id)).toBe(false);
      const none = await read.orderFlow(db, 7, new Date(since.getTime() + 31 * MIN), []);
      expect(none.stuck).toEqual([]);
    });
  });

  it('keeps one row per wait in the database itself', async () => {
    await useTarget();
    const { id, since } = await waiting();
    await sla.sweep(companyId, new Date(since.getTime() + 31 * MIN));
    const [b] = await breaches(id);
    // Copied inside the database, so the time keeps its microseconds.
    await expect(db.execute(sql`INSERT INTO order_sla_breaches (company_id, order_id, stage, entered_at, target_minutes, escalate_after_minutes) SELECT company_id, order_id, stage, entered_at, target_minutes, escalate_after_minutes FROM order_sla_breaches WHERE id = ${b?.id ?? ''}::uuid`)).rejects.toThrow();
    const rows = await db.select({ n: sql<number>`count(*)::int` }).from(schema.orderSlaBreaches).where(and(eq(schema.orderSlaBreaches.orderId, id), eq(schema.orderSlaBreaches.stage, 'payment_started')));
    expect(rows[0]?.n).toBe(1);
  });
});
