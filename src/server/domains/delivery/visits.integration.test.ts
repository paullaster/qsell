import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
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

  /** A product with 20 on the default shelf, for materials. */
  const stocked = async () => {
    const productId = `prod_vm_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `VM-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `VMS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Cable ${productId.slice(-6)}`, slug: `vm-${randomUUID()}`, itemTypeId, price: '100', costPrice: '12', taxRate: '0', isTaxInclusive: false, stockQuantity: 0 });
    const loc = await c.stockLocations.ensureDefault(companyId);
    await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId: loc.id, type: 'receipt', quantity: 20, unitCost: 12, actor: { type: 'job' } }));
    return { productId, locationId: loc.id };
  };
  const onHand = async (productId: string): Promise<number> => (await db.select().from(schema.stockBalances).where(eq(schema.stockBalances.productId, productId))).reduce((n, b) => n + b.onHand, 0);
  /** A visit with a crew member, already on site. */
  const onSite = async () => {
    const a = await staff();
    const v = await must(book(await order(), { crewIds: [a] }));
    await must(c.orderVisits.start(crewOf(a), v.id));
    return { v, a };
  };

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

  it('is cancelled with its order when the visit has not started, and a visit already on site is left to a person', async () => {
    const a = await staff();
    const planned = await must(book(await order()));
    const crewed = await must(book(await order(), { crewIds: [a] }));
    const there = await onSite();
    const stillOpen = await must(book(await order()));
    for (const v of [planned, crewed, there.v]) {
      await OrderStages.move(db, v.orderId, 'cancelled', 'cancelled', { reasonCode: 'cancelled', message: 'test' });
    }
    const read = async (id: string) => ({ data: await c.orderVisits.view(office(), id) });
    for (const v of [planned, crewed]) {
      const after = await read(v.id);
      expect(after.data).toMatchObject({ status: 'cancelled', cancelReason: expect.stringContaining('cancelled or refunded') as string, version: v.version + 1 });
      // The order's own timeline already says it was cancelled, and no failed delivery is added for a crew that never went.
      expect(await stagesOf(v.orderId)).not.toContain('delivery_failed:failed');
    }
    expect((await read(there.v.id)).data?.status).toBe('on_site');
    expect((await read(stillOpen.id)).data?.status).toBe('scheduled');
    // A visit booked before visits followed their order is cancelled by the sweep, once.
    await db.update(schema.orders).set({ status: 'cancelled' }).where(eq(schema.orders.id, stillOpen.orderId));
    expect(await c.orderVisits.closeForClosedOrders()).toBeGreaterThanOrEqual(1);
    expect((await read(stillOpen.id)).data?.status).toBe('cancelled');
    expect(await c.orderVisits.closeForClosedOrders()).toBe(0);
    // And a cancelled order cannot be given a new visit.
    expect(await book(planned.orderId)).toMatchObject({ ok: false, reason: 'order_not_ready' });
  });

  it('tells the customer by mail when a visit is booked, moved or cancelled: when, with no address, phone or note, once for each change, and not when it no longer applies', async () => {
    const { DeliveryMessages } = await import('./messages');
    const sent: { to: string; subject: string; text: string }[] = [];
    const flusher = new DeliveryMessages(db, { name: 'test', send: (m: { to: string; subject: string; text?: string }) => { sent.push({ to: m.to, subject: m.subject, text: m.text ?? '' }); return Promise.resolve({ messageId: 'x', provider: 'test' }); } }, c.companySettings, { tokenFor: () => Promise.resolve('tok9') });
    const o = await order();
    const queued = async (kind: string) => (await db.select().from(schema.deliveryMessages).where(and(eq(schema.deliveryMessages.orderId, o), eq(schema.deliveryMessages.kind, kind)))).filter((m) => m.channel === 'email');
    const v = await must(book(o, { notes: 'Dog in the yard', contactPhone: '0799888777' }));
    expect((await queued('visit_booked')).map((m) => m.messageKey)).toEqual([`${v.id}:visit_booked:1`]);
    await flusher.flush(500);
    const mine = (): typeof sent => sent.filter((m) => m.subject.includes(v.orderNumber));
    const mail = mine().filter((m) => m.subject.includes('is booked'));
    expect(mail).toHaveLength(1);
    expect(mail[0]?.text).toMatch(/\d{2}:\d{2} to \d{2}:\d{2}/);
    expect(mail[0]?.text).toContain('/profile/orders');
    expect(mail[0]?.text).not.toMatch(/Dog in the yard|0799888777|Kileleshwa|Gate 4/);
    // Moved: a message of its own for each move; a refused move (a stale copy) sends nothing.
    const moved = await must(c.orderVisits.reschedule(office(), v.id, { startsAt: day(6, 8), endsAt: day(6, 11), reason: 'Customer asked for later', expectedVersion: v.version }));
    expect(await c.orderVisits.reschedule(office(), v.id, { startsAt: day(7, 8), endsAt: day(7, 11), reason: 'Stale copy', expectedVersion: v.version })).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await queued('visit_moved')).map((m) => m.messageKey)).toEqual([`${v.id}:visit_moved:${String(v.version + 1)}`]);
    // Cancelled: told; and the booking and move messages still waiting are not sent late for a visit that is gone.
    await must(c.orderVisits.cancel(office(), v.id, { reason: 'Customer is travelling', expectedVersion: moved.version }));
    sent.length = 0;
    await flusher.flush(500);
    expect(mine().some((m) => m.subject.includes('was cancelled'))).toBe(true);
    expect(mine().some((m) => m.subject.includes('has moved'))).toBe(false);
    const skipped = (await queued('visit_moved')).concat(await queued('visit_booked')).filter((m) => m.status === 'skipped' || m.status === 'sent');
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    // The office sees what was written, in order, with the address hidden and whether it left; the crew see none of it; another visit's messages are not mixed in.
    const told = (await c.orderVisits.view(office(), v.id))?.messages ?? [];
    expect(told.map((m) => m.kind)).toEqual(['visit_booked', 'visit_moved', 'visit_cancelled']);
    expect(told.every((m) => m.channel === 'email')).toBe(true);
    expect(told.some((m) => m.status === 'sent')).toBe(true);
    expect(told.every((m) => m.recipient === '' || m.recipient.includes('*'))).toBe(true);
    expect(JSON.stringify(told)).not.toMatch(/vs-[0-9a-f]{8}-/);
    const member = await staff();
    const crewed = await must(book(await order(), { crewIds: [member] }));
    expect((await c.orderVisits.view(office(), crewed.id))?.messages.map((m) => m.kind)).toEqual(['visit_booked']);
    expect((await c.orderVisits.view(crewOf(member), crewed.id))?.messages).toEqual([]);
    // The order's own cancellation closes visits quietly: no second message for it.
    const other = await order();
    const open = await must(book(other));
    await OrderStages.move(db, other, 'cancelled', 'cancelled', { reasonCode: 'cancelled', message: 'test' });
    expect((await db.select().from(schema.deliveryMessages).where(and(eq(schema.deliveryMessages.orderId, other), eq(schema.deliveryMessages.kind, 'visit_cancelled')))).length).toBe(0);
    expect(open.status).toBe('scheduled');
  });

  it('shows the customer only when, where and how it stands, soonest first, for their own order', async () => {
    const a = await staff();
    const o = await order();
    const first = await must(book(o, { crewIds: [a], notes: 'Dog in the yard', contactPhone: '0799888777' }));
    expect(first.status).toBe('crew_assigned');
    const seen = await c.orderVisits.forCustomer(companyId, o);
    expect(seen).toEqual([{ status: 'crew_assigned', startsAt: first.startsAt, endsAt: first.endsAt, address: 'Kileleshwa, Nairobi, Gate 4' }]);
    expect(JSON.stringify(seen)).not.toMatch(/Dog in the yard|0799888777|crewIds|userId/);
    // Cancelled visits are still told, and a replacement is listed after it by time.
    await must(c.orderVisits.cancel(office(), first.id, { reason: 'Customer is travelling', expectedVersion: first.version }));
    await must(book(o, { startsAt: day(5, 8), endsAt: day(5, 11) }));
    expect((await c.orderVisits.forCustomer(companyId, o)).map((v) => v.status)).toEqual(['cancelled', 'scheduled']);
    // Another company's id, or another order, shows nothing.
    expect(await c.orderVisits.forCustomer(randomUUID(), o)).toEqual([]);
    expect(await c.orderVisits.forCustomer(companyId, await order())).toEqual([]);
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

  /** Every visit of a list, a page at a time, in the order they come. */
  const allOf = async (status?: 'live' | 'cancelled') => {
    const ids: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 20; page += 1) {
      const got: Awaited<ReturnType<typeof c.orderVisits.list>> = await c.orderVisits.list(office(), { ...(status === undefined ? {} : { status }), cursor });
      ids.push(...got.rows.map((r) => r.id));
      cursor = got.nextCursor;
      if (cursor === null) break;
    }
    return ids;
  };

  it('is listed soonest first, a page at a time, live ones by default and a state on request', async () => {
    const a = await order();
    const b = await order();
    const early = await must(book(a, { startsAt: day(5, 7), endsAt: day(5, 9) }));
    const later = await must(book(b, { startsAt: day(5, 13), endsAt: day(5, 15) }));
    const ids = await allOf();
    expect(ids.indexOf(early.id)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(early.id)).toBeLessThan(ids.indexOf(later.id));
    expect(new Set(ids).size).toBe(ids.length);
    await must(c.orderVisits.cancel(office(), later.id, { reason: 'Not needed now', expectedVersion: later.version }));
    expect(await allOf()).not.toContain(later.id);
    expect(await allOf('cancelled')).toContain(later.id);
    const first = await c.orderVisits.list(office(), { cursor: 'not-a-cursor' });
    expect(first.rows.length).toBeGreaterThan(0);
  });

  it('uses materials from stock while the crew is on site, and not before or after', async () => {
    const { productId } = await stocked();
    const a = await staff();
    const v = await must(book(await order(), { crewIds: [a] }));
    expect(await c.orderVisits.useMaterial(crewOf(a), v.id, { productId, quantity: 2 })).toMatchObject({ ok: false, reason: 'not_allowed' });
    await must(c.orderVisits.start(crewOf(a), v.id));
    const used = await must(c.orderVisits.useMaterial(crewOf(a), v.id, { productId, quantity: 2.5, note: 'Cable for the unit' }));
    expect(used.materials).toHaveLength(1);
    expect(used.materials[0]).toMatchObject({ productId, quantity: 2.5, canGiveBack: true, givenBack: false, note: 'Cable for the unit' });
    expect(await onHand(productId)).toBe(17.5);
    const [line] = await db.select().from(schema.stockMovements).where(eq(schema.stockMovements.documentId, v.id));
    expect(line).toMatchObject({ movementType: 'sale_issue', documentType: 'visit' });
    expect(Number(line?.unitCost)).toBe(12);

    const [first, second] = used.items;
    await must(c.orderVisits.tick(crewOf(a), v.id, first?.id ?? '', true));
    await must(c.orderVisits.tick(crewOf(a), v.id, second?.id ?? '', true));
    await must(c.orderVisits.complete(crewOf(a), v.id));
    // Still open for materials until it is signed off, and then closed.
    expect((await c.orderVisits.useMaterial(crewOf(a), v.id, { productId, quantity: 1 })).ok).toBe(true);
    await must(c.orderVisits.signOff(crewOf(a), v.id, { name: 'Mama Wanjiku' }));
    expect(await c.orderVisits.useMaterial(crewOf(a), v.id, { productId, quantity: 1 })).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(await onHand(productId)).toBe(16.5);
  });

  /** A photo as the upload route leaves it: private, of the visit purpose, the taker's own, and not yet used. */
  const uploaded = async (userId: string, over: { purpose?: string; visibility?: 'private' | 'public' } = {}): Promise<string> => {
    const id = randomUUID();
    await db.insert(schema.mediaAssets).values({ id, provider: 'local', visibility: over.visibility ?? 'private', purpose: over.purpose ?? 'visit_photo', storageKey: `visit_photo/${id}.jpg`, mime: 'image/jpeg', status: 'pending', createdBy: userId, createdByEmail: '' });
    return id;
  };

  it('keeps the photos the crew takes while it is on site, only their own and only once, up to 20, and not before or after', async () => {
    const a = await staff();
    const b = await staff();
    const v = await must(book(await order(), { crewIds: [a, b] }));
    const early = await uploaded(a);
    expect(await c.orderVisits.addPhoto(crewOf(a), v.id, { photoId: early, kind: 'before' })).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('Photos are kept once the crew is on site') as string });
    await must(c.orderVisits.start(crewOf(a), v.id));
    // What the photo shows is asked for; a photo that is not theirs, not of this kind, public, already used or invented is refused alike.
    expect(await c.orderVisits.addPhoto(crewOf(a), v.id, { photoId: early, kind: 'nonsense' })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('what the photo shows') as string });
    for (const photoId of [await uploaded(b), await uploaded(a, { purpose: 'delivery_proof' }), await uploaded(a, { visibility: 'public' }), randomUUID(), '', 7]) {
      expect(await c.orderVisits.addPhoto(crewOf(a), v.id, { photoId, kind: 'before' })).toMatchObject({ ok: false, reason: 'bad_input', message: 'That photo could not be used. Take it again.' });
    }
    const kept = await must(c.orderVisits.addPhoto(crewOf(a), v.id, { photoId: early, kind: 'before', caption: '  Old unit in place  ' }));
    expect(kept.photos).toHaveLength(1);
    expect(kept.photos[0]).toMatchObject({ kind: 'before', caption: 'Old unit in place', by: expect.stringContaining('Fundi') as string, canRemove: true });
    expect(kept.photos[0]).not.toHaveProperty('mediaId');
    // It is not an unused upload any more. Sent again for the same visit (a retry) it is not added twice; it is never shared with another visit.
    expect((await db.select({ s: schema.mediaAssets.status }).from(schema.mediaAssets).where(eq(schema.mediaAssets.id, early)))[0]?.s).toBe('ready');
    expect((await must(c.orderVisits.addPhoto(crewOf(a), v.id, { photoId: early, kind: 'before' }))).photos).toHaveLength(1);
    const elsewhere = await must(book(await order(), { crewIds: [a] }));
    await must(c.orderVisits.start(crewOf(a), elsewhere.id));
    expect(await c.orderVisits.addPhoto(crewOf(a), elsewhere.id, { photoId: early, kind: 'after' })).toMatchObject({ ok: false, reason: 'bad_input', message: 'That photo could not be used. Take it again.' });
    // A fellow crew member and the office see it; the other crew member may not take it off, the office may.
    expect((await must(c.orderVisits.addPhoto(crewOf(b), v.id, { photoId: await uploaded(b), kind: 'after' }))).photos).toHaveLength(2);
    const seenByB = await c.orderVisits.view(crewOf(b), v.id);
    expect(seenByB?.photos.map((p) => [p.kind, p.canRemove])).toEqual([['before', false], ['after', true]]);
    const first = kept.photos[0]?.id ?? '';
    expect(await c.orderVisits.removePhoto(crewOf(b), v.id, first, { reason: 'Not mine to remove' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(await c.orderVisits.removePhoto(crewOf(a), v.id, first, { reason: '' })).toMatchObject({ ok: false, reason: 'bad_input' });
    const after = await must(c.orderVisits.removePhoto(crewOf(a), v.id, first, { reason: 'Blurred, taking it again' }));
    expect(after.photos).toHaveLength(1);
    expect((await db.select({ d: schema.mediaAssets.deletedAt }).from(schema.mediaAssets).where(eq(schema.mediaAssets.id, early)))[0]?.d).not.toBeNull();
    // The office may take off anyone's.
    const other = after.photos[0]?.id ?? '';
    expect((await must(c.orderVisits.removePhoto(office(), v.id, other, { reason: 'Shows the customer' }))).photos).toHaveLength(0);
    // The limit: 20 on a visit.
    for (let i = 0; i < 20; i += 1) await must(c.orderVisits.addPhoto(crewOf(a), v.id, { photoId: await uploaded(a), kind: 'other' }));
    expect(await c.orderVisits.addPhoto(crewOf(a), v.id, { photoId: await uploaded(a), kind: 'other' })).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('at most 20') as string });
    // Each is on the order's decision log, and once the work is signed off nothing can be added or taken off.
    const log = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, v.orderId), inArray(schema.decisionLog.action, ['visit.photo_added', 'visit.photo_removed'])));
    expect(log.filter((l) => l.action === 'visit.photo_added')).toHaveLength(22);
    expect(log.filter((l) => l.action === 'visit.photo_removed')).toHaveLength(2);
    const [i1, i2] = (await c.orderVisits.view(crewOf(a), v.id))?.items ?? [];
    await must(c.orderVisits.tick(crewOf(a), v.id, i1?.id ?? '', true));
    await must(c.orderVisits.tick(crewOf(a), v.id, i2?.id ?? '', true));
    await must(c.orderVisits.complete(crewOf(a), v.id));
    await must(c.orderVisits.signOff(crewOf(a), v.id, { name: 'Mama Wanjiku' }));
    expect(await c.orderVisits.addPhoto(crewOf(a), v.id, { photoId: await uploaded(a), kind: 'after' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    const last = (await c.orderVisits.view(crewOf(a), v.id))?.photos[0];
    expect(last?.canRemove).toBe(false);
    expect(await c.orderVisits.removePhoto(office(), v.id, last?.id ?? '', { reason: 'Too late to change' })).toMatchObject({ ok: false, reason: 'not_allowed' });
  });

  it('gives a photo to those who may see the visit and to no one else', async () => {
    const a = await staff();
    const b = await staff();
    const v = await must(book(await order(), { crewIds: [a] }));
    await must(c.orderVisits.start(crewOf(a), v.id));
    const mediaId = await uploaded(a);
    const photo = (await must(c.orderVisits.addPhoto(crewOf(a), v.id, { photoId: mediaId, kind: 'after' }))).photos[0];
    expect(await c.orderVisits.photoMedia(crewOf(a), v.id, photo?.id ?? '')).toBe(mediaId);
    expect(await c.orderVisits.photoMedia(office(), v.id, photo?.id ?? '')).toBe(mediaId);
    // A crew member who is not on this visit, another company, and ids that are not ids learn nothing.
    expect(await c.orderVisits.photoMedia(crewOf(b), v.id, photo?.id ?? '')).toBeNull();
    expect(await c.orderVisits.photoMedia({ companyId: randomUUID(), userId: a, crewOnly: false }, v.id, photo?.id ?? '')).toBeNull();
    expect(await c.orderVisits.photoMedia(office(), v.id, randomUUID())).toBeNull();
    expect(await c.orderVisits.photoMedia(office(), 'x', 'y')).toBeNull();
    // The database does not let a photo name a kind we do not know, or a caption that is too long.
    await expect(db.insert(schema.orderVisitPhotos).values({ visitId: v.id, mediaId: await uploaded(a), kind: 'nonsense' as 'other', takenBy: a })).rejects.toThrow();
    await expect(db.insert(schema.orderVisitPhotos).values({ visitId: v.id, mediaId: await uploaded(a), kind: 'other', caption: 'x'.repeat(201), takenBy: a })).rejects.toThrow();
  });

  it('refuses materials that are not there, a bad amount, a stranger on the crew list and a visit that is not theirs', async () => {
    const { productId } = await stocked();
    const { v, a } = await onSite();
    expect(await c.orderVisits.useMaterial(crewOf(a), v.id, { productId, quantity: 500 })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringMatching(/not enough stock/) as string });
    for (const quantity of [0, -1, 'two', 0.0004, Number.NaN]) expect(await c.orderVisits.useMaterial(crewOf(a), v.id, { productId, quantity })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.orderVisits.useMaterial(crewOf(a), v.id, { productId: 'no-such-product', quantity: 1 })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await c.orderVisits.useMaterial(crewOf(a), v.id, { productId, locationId: 'nowhere', quantity: 1 })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.orderVisits.useMaterial(crewOf(await staff()), v.id, { productId, quantity: 1 })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await onHand(productId)).toBe(20);
    // A refused line leaves no trace in the visit.
    expect(await db.select().from(schema.orderVisitMaterials).where(eq(schema.orderVisitMaterials.visitId, v.id))).toHaveLength(0);
  });

  it('gives material back once and in full, to where it came from, with a reason', async () => {
    const { productId } = await stocked();
    const { v, a } = await onSite();
    const used = await must(c.orderVisits.useMaterial(crewOf(a), v.id, { productId, quantity: 4 }));
    const lineId = used.materials[0]?.id ?? '';
    expect(await c.orderVisits.giveBackMaterial(crewOf(a), v.id, lineId, { reason: 'no' })).toMatchObject({ ok: false, reason: 'bad_input' });
    const back = await must(c.orderVisits.giveBackMaterial(crewOf(a), v.id, lineId, { reason: 'Not needed after all' }));
    expect(back.materials.map((m) => m.quantity)).toEqual([4, -4]);
    expect(back.materials[0]).toMatchObject({ givenBack: true, canGiveBack: false });
    expect(await onHand(productId)).toBe(20);
    expect(await c.orderVisits.giveBackMaterial(crewOf(a), v.id, lineId, { reason: 'Again, by mistake' })).toMatchObject({ ok: false, reason: 'conflict' });
    const undoLine = back.materials[1]?.id ?? '';
    expect(await c.orderVisits.giveBackMaterial(crewOf(a), v.id, undoLine, { reason: 'Back of a giving back' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(await c.orderVisits.giveBackMaterial(crewOf(a), v.id, randomUUID(), { reason: 'Not on this visit' })).toMatchObject({ ok: false, reason: 'not_found' });
    await expect(db.update(schema.orderVisitMaterials).set({ quantity: '1' }).where(eq(schema.orderVisitMaterials.id, lineId))).rejects.toThrow();
    await expect(db.delete(schema.orderVisitMaterials).where(eq(schema.orderVisitMaterials.id, lineId))).rejects.toThrow();
  });
});
