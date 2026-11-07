import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { has } from '@/lib/values';
import { addDays, nairobiDay } from '@/lib/delivery-slot';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import type { OrderStages as OrderStagesType } from '@/server/domains/orders/stages';
import { holdLedgerSwitch, settleFinanceBacklog } from '@/server/domains/stock/test-support';

const { requirePermission } = vi.hoisted(() => ({ requirePermission: vi.fn() }));
vi.mock('@/server/domains/access-control/guard', async (original) => ({ ...(await original<Record<string, unknown>>()), requirePermission }));
vi.mock('@/server/domains/finance/action-runner', () => ({ injectedDelay: () => Promise.resolve() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/auth', () => ({ auth: () => Promise.resolve(null) }));

/**
 * Delivery slots, against a real database: making and changing them, what a branch offers over some days with the room left, booking a
 * delivery into one (the last place goes to one of two people booking at once), letting it go, the days with no slots, and what is refused.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

const PIN = { latitude: -1.2921, longitude: 36.8219 };

describe.skipIf(!has(url))('delivery slots (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let OrderStages: typeof OrderStagesType;
  let companyId: string;
  let releaseLedgerSwitch: (() => Promise<void>) | undefined;
  let itemTypeId: string;
  let spy: { mockRestore: () => void } | undefined;
  let branchId = '';
  let otherBranchId = '';
  let locationId = '';
  const tag = randomUUID().slice(0, 6).toUpperCase();
  let n = 0;
  const code = () => `SL${tag}${String((n += 1)).padStart(3, '0')}`;
  const actor = () => ({ companyId, userId: 'dispatcher-1' });
  const today = () => nairobiDay(new Date());
  /** A day a few days ahead: slots on it are not cut off. */
  const ahead = (days: number) => addDays(today(), days);

  const must = async <T,>(p: Promise<{ ok: true; data: T } | { ok: false; message: string }>): Promise<T> => {
    const r = await p;
    if (!r.ok) throw new Error(r.message);
    return r.data;
  };
  const slot = async (over: Record<string, unknown> = {}) => await must(c.deliverySlots.create(actor(), { branchId, name: `Slot ${code()}`, weekdays: [1, 2, 3, 4, 5, 6, 7], startsAt: '09:00', endsAt: '12:00', capacity: 3, cutoffMinutes: 60, ...over }));
  /** A paid order delivered by the shop's own riders from the test branch, with its delivery made (a draft). */
  const delivery = async () => {
    const productId = `prod_sl_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `SL-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `SLS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Slotted ${productId.slice(-6)}`, slug: `sl-${randomUUID()}`, itemTypeId, price: '1000', costPrice: '10', taxRate: '0', isTaxInclusive: false, stockQuantity: 0 });
    await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId, type: 'receipt', quantity: 50, unitCost: 10, actor: { type: 'job' } }));
    const r = await createOrder({
      orderNumber: `SL-${randomUUID()}`, customerName: 'Wanjiru Buyer', customerEmail: `sl-${randomUUID()}@slots.test`, customerPhone: '0700123456',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja', delivery: { method: 'own_fleet', pin: PIN },
    });
    if (!r.success || r.order === undefined) throw new Error(r.error);
    await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    const doc = await c.deliveryDocuments.create(actor(), r.order.id, { lines: null });
    if (!doc.ok) throw new Error(doc.message);
    return doc.data.id;
  };
  const rowOf = async (id: string) => (await db.select().from(schema.deliveries).where(eq(schema.deliveries.id, id)))[0];

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
    await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Slots Test Co');
    itemTypeId = `it_sl_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    const ctx = { companyId, actor: { type: 'user' as const, id: 'tester' }, origin: { surface: 'test', action: 'run' } };
    await c.reasonCodes.ensureSystemReasons(companyId);
    await c.finance.setup.applyTemplate(ctx, 'kenya', { fiscalYearStart: '2026-01-01' }).catch(() => undefined);
    await c.finance.paymentMethods.seedStandard(ctx);
    await c.stockLocations.ensureDefault(companyId);
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    // One branch that delivers, with its shelf and a charge, and another branch for the wrong-branch refusals.
    const [b] = await db.insert(schema.branches).values({ companyId, code: code(), name: `Slots Branch ${code()}`, latitude: PIN.latitude, longitude: PIN.longitude }).returning();
    branchId = b?.id ?? '';
    const [o] = await db.insert(schema.branches).values({ companyId, code: code(), name: `Far Branch ${code()}`, latitude: -4.0435, longitude: 39.6682 }).returning();
    otherBranchId = o?.id ?? '';
    await db.insert(schema.deliveryMethods).values({ companyId, branchId, method: 'own_fleet' });
    const loc = await c.stockLocations.create(companyId, { code: code(), name: 'Shelf', kind: 'store', branchId, fulfilsDelivery: true });
    locationId = loc.id;
    const policies = await import('./policy-actions');
    requirePermission.mockResolvedValue('dispatcher-1');
    const made = await policies.createChargePolicyDraftAction(code(), { name: 'Flat', method: 'flat', currency: 'KES', scopes: { branch: { op: 'in', values: [branchId] } }, rates: [{ zoneId: null, fromKg: 0, toKg: null, fee: 300 }], taxRate: 0 });
    if (!made.ok) throw new Error(made.error);
    const live = await policies.activateChargePolicyAction(made.data.id, 'Set up for the test');
    if (!live.ok) throw new Error(live.error);
  }, 900_000);
  afterAll(async () => {
    await releaseLedgerSwitch?.();
    spy?.mockRestore();
    await c.stockSettings.setLedgerMode(companyId, false);
    const ids = [branchId, otherBranchId].filter((x) => x !== '');
    if (ids.length > 0) await db.update(schema.branches).set({ isActive: false }).where(inArray(schema.branches.id, ids));
    await settleFinanceBacklog(c.finance);
  }, 120_000);
  beforeEach(() => {
    requirePermission.mockReset().mockResolvedValue('dispatcher-1');
  });
  afterEach(async () => {
    // Slots from one test must not be offered in the next.
    await db.update(schema.deliverySlots).set({ isActive: false }).where(inArray(schema.deliverySlots.branchId, [branchId, otherBranchId]));
  });

  it('makes a slot, refuses a bad one or a repeated name or a branch that is not there, and changes one with a version', async () => {
    const s = await slot({ name: `Morning ${code()}` });
    expect(s).toMatchObject({ capacity: 3, startsAt: '09:00', endsAt: '12:00', weekdaysWords: 'Every day', isActive: true });
    expect(await c.deliverySlots.create(actor(), { branchId, name: s.name, weekdays: [1], startsAt: '09:00', endsAt: '10:00', capacity: 1, cutoffMinutes: 0 })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await c.deliverySlots.create(actor(), { branchId, name: 'x', weekdays: [1], startsAt: '09:00', endsAt: '10:00', capacity: 1, cutoffMinutes: 0 })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.deliverySlots.create(actor(), { branchId, name: `Late ${code()}`, weekdays: [1], startsAt: '12:00', endsAt: '09:00', capacity: 1, cutoffMinutes: 0 })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.deliverySlots.create(actor(), { branchId: randomUUID(), name: `Ghost ${code()}`, weekdays: [1], startsAt: '09:00', endsAt: '10:00', capacity: 1, cutoffMinutes: 0 })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.deliverySlots.create({ ...actor(), companyId: randomUUID() }, { branchId, name: `Other ${code()}`, weekdays: [1], startsAt: '09:00', endsAt: '10:00', capacity: 1, cutoffMinutes: 0 })).toMatchObject({ ok: false });

    const changed = await must(c.deliverySlots.update(actor(), s.id, { name: s.name, weekdays: [1, 2, 3, 4, 5], startsAt: '08:00', endsAt: '11:00', capacity: 5, cutoffMinutes: 30, expectedVersion: s.version }));
    expect(changed).toMatchObject({ capacity: 5, weekdaysWords: 'Weekdays', version: s.version + 1 });
    expect(await c.deliverySlots.update(actor(), s.id, { name: s.name, weekdays: [1], startsAt: '08:00', endsAt: '11:00', capacity: 5, cutoffMinutes: 30, expectedVersion: s.version })).toMatchObject({ ok: false, reason: 'conflict' });
    const stopped = await must(c.deliverySlots.setActive(actor(), s.id, { isActive: false, expectedVersion: changed.version }));
    expect(stopped.isActive).toBe(false);
    expect(await c.deliverySlots.setActive(actor(), s.id, { isActive: true, expectedVersion: changed.version })).toMatchObject({ ok: false, reason: 'conflict' });
    expect(await c.deliverySlots.setActive(actor(), 'nope', { isActive: true, expectedVersion: 1 })).toMatchObject({ ok: false, reason: 'not_found' });
  });

  it('offers a branch\'s slots by day with the room left, leaving out stopped slots, other branches\' slots and days that are closed', async () => {
    const weekday = new Date(`${ahead(2)}T00:00:00Z`).getUTCDay() === 0 ? 7 : new Date(`${ahead(2)}T00:00:00Z`).getUTCDay();
    const only = await slot({ name: `OneDay ${code()}`, weekdays: [weekday], capacity: 2 });
    await slot({ name: `Daily ${code()}` });
    const stopped = await slot({ name: `Stopped ${code()}` });
    await must(c.deliverySlots.setActive(actor(), stopped.id, { isActive: false, expectedVersion: stopped.version }));
    await slot({ branchId: otherBranchId, name: `Elsewhere ${code()}` });
    const closed = await must(c.deliverySlots.close(actor(), { day: ahead(3), reason: 'Public holiday' }));

    const offer = await c.deliverySlots.offer(companyId, { branchId, from: today(), days: 7 });
    expect(offer).toHaveLength(7);
    const names = new Set(offer.flatMap((d) => d.slots.map((s) => s.name)));
    expect(names.has(only.name)).toBe(true);
    expect(names.has(stopped.name)).toBe(false);
    expect([...names].some((x) => x.startsWith('Elsewhere'))).toBe(false);
    const dayOf = (day: string) => offer.find((d) => d.day === day);
    expect(dayOf(ahead(2))?.slots.find((s) => s.slotId === only.id)).toMatchObject({ left: 2, available: true, why: null });
    // The one-weekday slot is not offered on the days around it.
    expect(dayOf(ahead(3))?.slots.find((s) => s.slotId === only.id)).toBeUndefined();
    expect(dayOf(ahead(3))).toMatchObject({ closedReason: 'Public holiday' });
    expect(dayOf(ahead(3))?.slots.every((s) => !s.available)).toBe(true);
    expect(dayOf(ahead(3))?.slots[0]?.why).toBe('No deliveries are made that day.');

    await must(c.deliverySlots.reopen(actor(), closed.id));
    expect((await c.deliverySlots.offer(companyId, { branchId, from: ahead(3), days: 1 }))[0]?.closedReason).toBeNull();
    expect(await c.deliverySlots.offer(companyId, { branchId: 'nope', days: 3 })).toEqual([]);
    expect(await c.deliverySlots.close(actor(), { day: ahead(-1), reason: 'Too late' })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.deliverySlots.close(actor(), { day: ahead(4), reason: 'x' })).toMatchObject({ ok: false, reason: 'bad_input' });
    await must(c.deliverySlots.close(actor(), { day: ahead(4), branchId, reason: 'Stocktake' }));
    expect(await c.deliverySlots.close(actor(), { day: ahead(4), branchId, reason: 'Stocktake again' })).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await c.deliverySlots.closedDays(companyId)).some((d) => d.day === ahead(4) && d.branchName !== null)).toBe(true);
  });

  it('promises a delivery a slot with the window as it was, which a later change to the slot does not move', async () => {
    const s = await slot({ name: `Promise ${code()}`, startsAt: '09:00', endsAt: '12:00' });
    const id = await delivery();
    const held = await must(c.deliverySlots.book(actor(), id, { slotId: s.id, day: ahead(2) }));
    expect(held).toMatchObject({ slotId: s.id, day: ahead(2) });
    expect(held.windowStart).toBe(new Date(`${ahead(2)}T09:00:00+03:00`).toISOString());
    expect(held.windowEnd).toBe(new Date(`${ahead(2)}T12:00:00+03:00`).toISOString());
    const row = await rowOf(id);
    expect(row).toMatchObject({ slotId: s.id, slotBookedBy: 'dispatcher-1' });
    expect(row?.scheduledFor).toBe(ahead(2));
    await must(c.deliverySlots.update(actor(), s.id, { name: s.name, weekdays: [1, 2, 3, 4, 5, 6, 7], startsAt: '14:00', endsAt: '16:00', capacity: 3, cutoffMinutes: 60, expectedVersion: s.version }));
    expect((await c.deliverySlots.heldBy(companyId, id))?.windowStart).toBe(held.windowStart);
    const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, id));
    expect(log.some((l) => l.action === 'delivery.slot_booked')).toBe(true);
  });

  it('gives room for its capacity and no more, counts a delivery once, lets a place go and frees it when a delivery is cancelled', async () => {
    const s = await slot({ name: `Small ${code()}`, capacity: 2 });
    const [a, b, d] = [await delivery(), await delivery(), await delivery()];
    await must(c.deliverySlots.book(actor(), a, { slotId: s.id, day: ahead(2) }));
    await must(c.deliverySlots.book(actor(), b, { slotId: s.id, day: ahead(2) }));
    expect(await c.deliverySlots.book(actor(), d, { slotId: s.id, day: ahead(2) })).toMatchObject({ ok: false, reason: 'conflict', message: 'This slot is full that day.' });
    // Booking the same place again does not take a second.
    await must(c.deliverySlots.book(actor(), a, { slotId: s.id, day: ahead(2) }));
    // Another day is free.
    await must(c.deliverySlots.book(actor(), d, { slotId: s.id, day: ahead(3) }));
    expect((await c.deliverySlots.offer(companyId, { branchId, from: ahead(2), days: 1 }))[0]?.slots.find((x) => x.slotId === s.id)).toMatchObject({ left: 0, available: false });

    expect(await c.deliverySlots.release(actor(), b, { reason: 'no' })).toMatchObject({ ok: false, reason: 'bad_input' });
    await must(c.deliverySlots.release(actor(), b, { reason: 'Customer will be away' }));
    expect(await c.deliverySlots.heldBy(companyId, b)).toBeNull();
    expect((await rowOf(b))?.scheduledFor).toBeNull();
    expect(await c.deliverySlots.release(actor(), b, { reason: 'Again by mistake' })).toMatchObject({ ok: false, reason: 'not_allowed' });
    await must(c.deliverySlots.book(actor(), d, { slotId: s.id, day: ahead(2) }));
    const e = await delivery();
    expect(await c.deliverySlots.book(actor(), e, { slotId: s.id, day: ahead(2) })).toMatchObject({ ok: false, reason: 'conflict' });
    await db.update(schema.deliveries).set({ status: 'cancelled', closedAt: new Date() }).where(eq(schema.deliveries.id, d));
    await must(c.deliverySlots.book(actor(), e, { slotId: s.id, day: ahead(2) }));
  });

  it('gives the last place to one of two people booking at the same moment', async () => {
    const s = await slot({ name: `Last ${code()}`, capacity: 1 });
    const [a, b, d] = [await delivery(), await delivery(), await delivery()];
    const results = await Promise.all([a, b, d].map((id) => c.deliverySlots.book(actor(), id, { slotId: s.id, day: ahead(2) })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok && r.reason === 'conflict')).toHaveLength(2);
    const held = await db.select().from(schema.deliveries).where(eq(schema.deliveries.slotId, s.id));
    expect(held).toHaveLength(1);
  });

  it('refuses another branch\'s slot, a day it does not run, a day closed, past, too far ahead or cut off, and a delivery already out', async () => {
    const id = await delivery();
    const weekday = new Date(`${ahead(2)}T00:00:00Z`).getUTCDay() === 0 ? 7 : new Date(`${ahead(2)}T00:00:00Z`).getUTCDay();
    const wrongBranch = await slot({ branchId: otherBranchId, name: `Far ${code()}` });
    expect(await c.deliverySlots.book(actor(), id, { slotId: wrongBranch.id, day: ahead(2) })).toMatchObject({ ok: false, reason: 'bad_input' });
    const notToday = await slot({ name: `Other day ${code()}`, weekdays: [weekday === 7 ? 1 : weekday + 1] });
    expect(await c.deliverySlots.book(actor(), id, { slotId: notToday.id, day: ahead(2) })).toMatchObject({ ok: false, message: 'This slot does not run on that day.' });
    const s = await slot({ name: `Rules ${code()}` });
    await must(c.deliverySlots.close(actor(), { day: ahead(5), branchId, reason: 'Stocktake' }));
    expect(await c.deliverySlots.book(actor(), id, { slotId: s.id, day: ahead(5) })).toMatchObject({ ok: false, message: 'No deliveries are made that day.' });
    expect(await c.deliverySlots.book(actor(), id, { slotId: s.id, day: ahead(-1) })).toMatchObject({ ok: false, message: 'That day has passed.' });
    expect(await c.deliverySlots.book(actor(), id, { slotId: s.id, day: ahead(90) })).toMatchObject({ ok: false, message: 'Slots can be booked up to 60 days ahead.' });
    const late = await slot({ name: `Cut ${code()}`, cutoffMinutes: 10_000 });
    expect(await c.deliverySlots.book(actor(), id, { slotId: late.id, day: ahead(2) })).toMatchObject({ ok: false, message: 'It is too late to book this slot.' });
    expect(await c.deliverySlots.book(actor(), id, { slotId: s.id, day: '2026-02-31' })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.deliverySlots.book(actor(), 'nope', { slotId: s.id, day: ahead(2) })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await c.deliverySlots.book({ ...actor(), companyId: randomUUID() }, id, { slotId: s.id, day: ahead(2) })).toMatchObject({ ok: false, reason: 'not_found' });
    await db.update(schema.deliveries).set({ status: 'out_for_delivery', dispatchedAt: new Date() }).where(eq(schema.deliveries.id, id));
    expect(await c.deliverySlots.book(actor(), id, { slotId: s.id, day: ahead(2) })).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(await rowOf(id)).toMatchObject({ slotId: null });
  });
});
