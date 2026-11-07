import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import type { OrderStages as OrderStagesType } from '@/server/domains/orders/stages';
import { holdLedgerSwitch, settleFinanceBacklog } from '@/server/domains/stock/test-support';

const { requirePermission, canPermission } = vi.hoisted(() => ({ requirePermission: vi.fn(), canPermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission, canPermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }));

/**
 * Booked visits, against a real database: booking for a paid order, the crew, moving and cancelling with a reason, the checklist that must
 * be ticked before the work is done, the customer's sign-off that delivers the order, who may act on what, and what each step writes to the
 * order's timeline.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('booked visits (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let OrderStages: typeof OrderStagesType;
  let companyId: string;
  let releaseLedgerSwitch: (() => Promise<void>) | undefined;
  let itemTypeId: string;
  let spy: { mockRestore: () => void } | undefined;
  const madeUsers: string[] = [];
  const office = () => ({ companyId, userId: 'office-1', crewOnly: false });
  const crewOf = (userId: string) => ({ companyId, userId, crewOnly: true });

  const day = (offsetDays: number, hour: number): string => {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() + offsetDays);
    d.setUTCHours(hour, 0, 0, 0);
    return d.toISOString();
  };
  const staff = async () => {
    const id = randomUUID();
    await db.insert(schema.users).values({ id, email: `vs-${id}@visits.test`, passwordHash: 'x', name: `Fundi ${id.slice(0, 4)}`, role: 'super_admin', phone: '0711000222' });
    madeUsers.push(id);
    return id;
  };
  /** A placed order, paid unless said otherwise. */
  const order = async (paid = true) => {
    const productId = `prod_vs_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `VS-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `VSS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Fitted ${productId.slice(-6)}`, slug: `vs-${randomUUID()}`, itemTypeId, price: '1000', costPrice: '10', taxRate: '0', isTaxInclusive: false, stockQuantity: 0 });
    const loc = await c.stockLocations.ensureDefault(companyId);
    await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId: loc.id, type: 'receipt', quantity: 50, unitCost: 10, actor: { type: 'job' } }));
    const r = await createOrder({ orderNumber: `VS-${randomUUID()}`, customerName: 'Wanjiru Buyer', customerEmail: `vs-${randomUUID()}@visits.test`, customerPhone: '0700123456', shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' }, items: [{ productId, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja' });
    if (!r.success || r.order === undefined) throw new Error(r.error);
    if (paid) await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    return r.order.id;
  };
  const book = async (orderId: string, over: Record<string, unknown> = {}) =>
    await c.orderVisits.book(office(), { orderId, startsAt: day(2, 8), endsAt: day(2, 11), address: 'Kileleshwa, Nairobi, Gate 4', contactName: 'Wanjiru', contactPhone: '0700123456', items: ['Fit the unit', 'Test it'], ...over });
  const must = async <T,>(p: Promise<{ ok: true; data: T } | { ok: false; message: string }>): Promise<T> => {
    const r = await p;
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };
  const stagesOf = async (orderId: string) => (await db.select().from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, orderId))).map((e) => `${e.stage}:${e.outcome}`);

  beforeAll(async () => {
    releaseLedgerSwitch = await holdLedgerSwitch(url);
    process.env.DATA_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString('base64');
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ OrderStages } = await import('@/server/domains/orders/stages'));
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    const ours = await c.companySettings.ensureSeeded();
    companyId = ours.id;
    spy = vi.spyOn(c.companySettings, 'ensureSeeded').mockResolvedValue(ours);
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Visits Test Co');
    itemTypeId = `it_vs_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const ctx = { companyId, actor: { type: 'user' as const, id: 'tester' }, origin: { surface: 'test', action: 'run' } };
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' }).catch(() => undefined);
    await c.finance.paymentMethods.seedStandard(ctx);
    await c.stockLocations.ensureDefault(companyId);
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  }, 900_000);
  afterAll(async () => {
    await releaseLedgerSwitch?.();
    spy?.mockRestore();
    await c.stockSettings.setLedgerMode(companyId, false);
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('office-1');
    canPermission.mockReset().mockResolvedValue(true);
  });
  afterEach(async () => {
    if (madeUsers.length > 0) await db.update(schema.users).set({ isActive: false }).where(inArray(schema.users.id, madeUsers));
  });

  it('is booked for a paid order, and the order has one live visit at a time', async () => {
    const orderId = await order();
    const v = await must(book(orderId));
    expect(v.status).toBe('scheduled');
    expect(v.items.map((i) => i.label)).toEqual(['Fit the unit', 'Test it']);
    expect((await book(orderId)).ok).toBe(false);
    const again = await book(orderId);
    expect(again).toMatchObject({ ok: false, reason: 'conflict' });
  });

  it('is refused for an order not paid for, a start in the past, an unreadable time and an empty checklist', async () => {
    expect(await book(await order(false))).toMatchObject({ ok: false, reason: 'order_not_ready' });
    const orderId = await order();
    expect(await book(orderId, { startsAt: day(-1, 8), endsAt: day(-1, 10) })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await book(orderId, { startsAt: 'soon' })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await book(orderId, { items: [] })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await book(orderId, { address: ' ' })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await book('no-such-order')).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await book(orderId, { crewIds: ['not-a-person'] })).toMatchObject({ ok: false, reason: 'bad_input' });
  });

  it('walks from a crew being named to the sign-off, and the order is delivered with each step on its timeline', async () => {
    const orderId = await order();
    const a = await staff();
    const v = await must(book(orderId));
    const assigned = await must(c.orderVisits.assign(office(), v.id, { crewIds: [a], expectedVersion: v.version }));
    expect(assigned.status).toBe('crew_assigned');
    expect(assigned.crew.map((m) => m.userId)).toEqual([a]);
    expect(await stagesOf(orderId)).toContain('dispatched:succeeded');

    const crew = crewOf(a);
    const onSite = await must(c.orderVisits.start(crew, v.id));
    expect(onSite.status).toBe('on_site');
    expect(await stagesOf(orderId)).toContain('out_for_delivery:succeeded');

    // The work is not done until each item is ticked.
    expect(await c.orderVisits.complete(crew, v.id)).toMatchObject({ ok: false, reason: 'nothing_left', message: '2 items are not ticked on the checklist yet.' });
    const [first, second] = onSite.items;
    await must(c.orderVisits.tick(crew, v.id, first?.id ?? '', true));
    expect(await c.orderVisits.complete(crew, v.id)).toMatchObject({ ok: false, message: '1 item is not ticked on the checklist yet.' });
    await must(c.orderVisits.tick(crew, v.id, second?.id ?? '', true));
    const done = await must(c.orderVisits.complete(crew, v.id));
    expect(done.status).toBe('completed');

    expect(await c.orderVisits.signOff(crew, v.id, { name: 'A' })).toMatchObject({ ok: false, reason: 'bad_input' });
    const signed = await must(c.orderVisits.signOff(crew, v.id, { name: 'Mama Wanjiku' }));
    expect(signed).toMatchObject({ status: 'signed_off', signedOffBy: 'Mama Wanjiku' });
    expect(signed.signedOffAt).not.toBeNull();
    expect(await stagesOf(orderId)).toContain('delivered:succeeded');
    const [o] = await db.select({ status: schema.orders.status }).from(schema.orders).where(eq(schema.orders.id, orderId));
    expect(o?.status).toBe('delivered');
    // Nothing leaves signed off.
    expect(await c.orderVisits.cancel(office(), v.id, { reason: 'Changed our mind', expectedVersion: signed.version })).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(await c.orderVisits.start(crew, v.id)).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('can be booked with a crew at once, and the crew and the time can be changed until the crew is on site', async () => {
    const orderId = await order();
    const a = await staff();
    const b = await staff();
    const v = await must(book(orderId, { crewIds: [a, b] }));
    expect(v.status).toBe('crew_assigned');
    expect(v.crew).toHaveLength(2);
    const swapped = await must(c.orderVisits.assign(office(), v.id, { crewIds: [b], expectedVersion: v.version }));
    expect(swapped.crew.map((m) => m.userId)).toEqual([b]);
    // Changing the crew again does not send the order out a second time.
    expect((await stagesOf(orderId)).filter((s) => s === 'dispatched:succeeded')).toHaveLength(1);
    const moved = await must(c.orderVisits.reschedule(office(), v.id, { startsAt: day(3, 9), endsAt: day(3, 12), reason: 'Customer asked for Thursday', expectedVersion: swapped.version }));
    expect(moved.startsAt).toBe(day(3, 9));
    expect(await c.orderVisits.reschedule(office(), v.id, { startsAt: day(4, 9), endsAt: day(4, 12), reason: 'no', expectedVersion: moved.version })).toMatchObject({ ok: false, reason: 'bad_input' });
    await must(c.orderVisits.start(crewOf(b), v.id));
    expect(await c.orderVisits.assign(office(), v.id, { crewIds: [a], expectedVersion: moved.version + 1 })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('refuses a change made on an old copy, a crew with someone twice or someone not on the staff', async () => {
    const orderId = await order();
    const a = await staff();
    const v = await must(book(orderId));
    const first = await must(c.orderVisits.assign(office(), v.id, { crewIds: [a], expectedVersion: v.version }));
    expect(await c.orderVisits.assign(office(), v.id, { crewIds: [a], expectedVersion: v.version })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await c.orderVisits.assign(office(), v.id, { crewIds: [a, a], expectedVersion: first.version })).toMatchObject({ ok: false, reason: 'bad_input' });
    const customer = randomUUID();
    await db.insert(schema.users).values({ id: customer, email: `c-${customer}@visits.test`, passwordHash: 'x', name: 'A Customer', role: 'customer' });
    madeUsers.push(customer);
    expect(await c.orderVisits.assign(office(), v.id, { crewIds: [customer], expectedVersion: first.version })).toMatchObject({ ok: false, reason: 'bad_input' });
  });

  it('is cancelled with a reason, before a crew goes with no stage and after one is sent as a failed delivery', async () => {
    const early = await order();
    const v1 = await must(book(early));
    expect(await c.orderVisits.cancel(office(), v1.id, { reason: 'x', expectedVersion: v1.version })).toMatchObject({ ok: false, reason: 'bad_input' });
    const gone = await must(c.orderVisits.cancel(office(), v1.id, { reason: 'Customer is travelling', expectedVersion: v1.version }));
    expect(gone).toMatchObject({ status: 'cancelled', cancelReason: 'Customer is travelling' });
    expect(await stagesOf(early)).not.toContain('delivery_failed:failed');
    // A cancelled visit can be replaced.
    expect((await book(early)).ok).toBe(true);

    const late = await order();
    const a = await staff();
    const v2 = await must(book(late, { crewIds: [a] }));
    await must(c.orderVisits.cancel(office(), v2.id, { reason: 'Site is not ready', expectedVersion: v2.version }));
    const failed = (await db.select().from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, late))).find((e) => e.stage === 'delivery_failed');
    expect(failed).toMatchObject({ outcome: 'failed', reasonCode: 'visit_cancelled' });
  });

  it('is acted on by the crew it names and no one else with the crew permission, and never deleted', async () => {
    const orderId = await order();
    const a = await staff();
    const stranger = await staff();
    const v = await must(book(orderId, { crewIds: [a] }));
    expect(await c.orderVisits.start(crewOf(stranger), v.id)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await c.orderVisits.view(crewOf(stranger), v.id)).toBeNull();
    expect((await c.orderVisits.list(crewOf(stranger))).rows.some((r) => r.id === v.id)).toBe(false);
    expect((await c.orderVisits.list(crewOf(a))).rows.some((r) => r.id === v.id)).toBe(true);
    expect((await c.orderVisits.list(office())).rows.some((r) => r.id === v.id)).toBe(true);
    expect(await c.orderVisits.start({ ...office(), companyId: randomUUID() }, v.id)).toMatchObject({ ok: false, reason: 'not_found' });
    await expect(db.delete(schema.orderVisits).where(eq(schema.orderVisits.id, v.id))).rejects.toThrow();
  });

  it('is listed soonest first, a page at a time, live ones by default and a state on request', async () => {
    const a = await order();
    const b = await order();
    const early = await must(book(a, { startsAt: day(5, 7), endsAt: day(5, 9) }));
    const later = await must(book(b, { startsAt: day(5, 13), endsAt: day(5, 15) }));
    const page = await c.orderVisits.list(office());
    const ids = page.rows.map((r) => r.id);
    expect(ids.indexOf(early.id)).toBeLessThan(ids.indexOf(later.id));
    await must(c.orderVisits.cancel(office(), later.id, { reason: 'Not needed now', expectedVersion: later.version }));
    expect((await c.orderVisits.list(office())).rows.some((r) => r.id === later.id)).toBe(false);
    expect((await c.orderVisits.list(office(), { status: 'cancelled' })).rows.some((r) => r.id === later.id)).toBe(true);
    const first = await c.orderVisits.list(office(), { cursor: 'not-a-cursor' });
    expect(first.rows.length).toBeGreaterThan(0);
  });
});
