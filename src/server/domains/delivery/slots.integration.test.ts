import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
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
  let lastProduct = '';
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
  const placeOrder = async (opts: { weight?: number; slot?: { slotId: string; day: string } } = {}) => {
    const productId = `prod_sl_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `SL-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `SLS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Slotted ${productId.slice(-6)}`, slug: `sl-${randomUUID()}`, itemTypeId, price: '1000', costPrice: '10', taxRate: '0', isTaxInclusive: false, stockQuantity: 0, ...(opts.weight === undefined ? {} : { weight: String(opts.weight) }) });
    lastProduct = productId;
    await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId, type: 'receipt', quantity: 50, unitCost: 10, actor: { type: 'job' } }));
    const r = await createOrder({
      orderNumber: `SL-${randomUUID()}`, customerName: 'Wanjiru Buyer', customerEmail: `sl-${randomUUID()}@slots.test`, customerPhone: '0700123456',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja', delivery: { method: 'own_fleet', pin: PIN, ...(opts.slot === undefined ? {} : { slot: opts.slot }) },
    });
    return r;
  };
  const delivery = async (opts: { weight?: number; slot?: { slotId: string; day: string } } = {}) => {
    const r = await placeOrder(opts);
    if (!r.success || r.order === undefined) throw new Error(r.error);
    await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    const doc = await c.deliveryDocuments.create(actor(), r.order.id, { lines: null });
    if (!doc.ok) throw new Error(doc.message);
    return doc.data.id;
  };
  /** An order placed with a slot chosen, paid but with no delivery made yet. */
  const orderWithSlot = async (slotChoice: { slotId: string; day: string }) => {
    const r = await placeOrder({ slot: slotChoice });
    if (!r.success || r.order === undefined) throw new Error(r.error);
    await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    return r.order.id;
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

  it('limits a slot by what its deliveries weigh, and a delivery heavier than the limit never fits', async () => {
    const s = await slot({ name: `Heavy ${code()}`, capacity: 10, maxWeightKg: 100 });
    expect(s.maxWeightKg).toBe(100);
    expect(await c.deliverySlots.create(actor(), { branchId, name: `Bad ${code()}`, weekdays: [1], startsAt: '09:00', endsAt: '10:00', capacity: 1, cutoffMinutes: 0, maxWeightKg: -4 })).toMatchObject({ ok: false, reason: 'bad_input' });
    const [a, b, d, huge] = [await delivery({ weight: 60 }), await delivery({ weight: 40 }), await delivery({ weight: 1 }), await delivery({ weight: 150 })];
    await must(c.deliverySlots.book(actor(), a, { slotId: s.id, day: ahead(2) }));
    await must(c.deliverySlots.book(actor(), b, { slotId: s.id, day: ahead(2) }));
    expect(await c.deliverySlots.book(actor(), d, { slotId: s.id, day: ahead(2) })).toMatchObject({ ok: false, reason: 'conflict', message: 'This slot cannot carry that much more that day.' });
    const shown = (await c.deliverySlots.offer(companyId, { branchId, from: ahead(2), days: 1, deliveryId: d }))[0]?.slots.find((x) => x.slotId === s.id);
    expect(shown).toMatchObject({ available: false, weightLeftKg: 0 });
    // Another day is empty; letting a place go makes room; a delivery over the limit alone never fits.
    await must(c.deliverySlots.book(actor(), d, { slotId: s.id, day: ahead(3) }));
    expect(await c.deliverySlots.book(actor(), huge, { slotId: s.id, day: ahead(8) })).toMatchObject({ ok: false, message: 'This slot cannot carry that much more that day.' });
    await must(c.deliverySlots.release(actor(), a, { reason: 'Customer will be away' }));
    const after = (await c.deliverySlots.offer(companyId, { branchId, from: ahead(2), days: 1, deliveryId: d }))[0]?.slots.find((x) => x.slotId === s.id);
    expect(after).toMatchObject({ available: true, weightLeftKg: 60 });
    // Goods with no weight count as nothing, and a slot with no limit takes any weight.
    const free = await slot({ name: `Free ${code()}`, capacity: 5 });
    await must(c.deliverySlots.book(actor(), huge, { slotId: free.id, day: ahead(2) }));
  });

  it('keeps a slot from starting before the goods can be ready: an item, a zone and the branch\'s own handling time', async () => {
    const s = await slot({ name: `Soon ${code()}`, startsAt: '00:30', endsAt: '23:00', cutoffMinutes: 0 });
    // An item that needs three days.
    const a = await delivery();
    const item = await must(c.deliverySlots.setLead(actor(), { kind: 'item', refId: lastProduct, minutes: 4320, note: 'Fresh fish' }));
    expect(item).toMatchObject({ kind: 'item', minutes: 4320, words: '3 days', note: 'Fresh fish' });
    const refused = await c.deliverySlots.book(actor(), a, { slotId: s.id, day: ahead(1) });
    expect(refused).toMatchObject({ ok: false, reason: 'not_allowed' });
    expect(!refused.ok && refused.message).toMatch(/will not be ready until .*\(Slotted /);
    const offered = (await c.deliverySlots.offer(companyId, { branchId, from: ahead(1), days: 9, deliveryId: a })).flatMap((d) => d.slots.filter((x) => x.slotId === s.id).map((x) => ({ day: d.day, ok: x.available })));
    expect(offered.find((x) => x.day === ahead(1))?.ok).toBe(false);
    expect(offered.find((x) => x.day === ahead(8))?.ok).toBe(true);
    await must(c.deliverySlots.book(actor(), a, { slotId: s.id, day: ahead(8) }));
    // The same item, changed to a shorter time, is one row, not two.
    await must(c.deliverySlots.setLead(actor(), { kind: 'item', refId: lastProduct, minutes: 60 }));
    expect((await c.deliverySlots.leadTimes(companyId)).filter((l) => l.refId === lastProduct)).toHaveLength(1);
    await must(c.deliverySlots.book(actor(), a, { slotId: s.id, day: ahead(1) }));

    // A zone: a delivery inside it has the zone on its charge; a lead time for the zone holds the delivery back.
    const zone = (await db.insert(schema.deliveryZones).values({ companyId, code: code(), name: `Far zone ${code()}`, centreLatitude: PIN.latitude, centreLongitude: PIN.longitude, radiusKm: '50.00' }).returning())[0];
    const b = await delivery();
    const [row] = await db.select({ orderId: schema.deliveries.orderId }).from(schema.deliveries).where(eq(schema.deliveries.id, b));
    const [od] = await db.select({ charge: schema.orderDeliveries.charge }).from(schema.orderDeliveries).where(eq(schema.orderDeliveries.orderId, row?.orderId ?? ''));
    expect(od?.charge.zone?.id).toBe(zone?.id);
    const lead = await must(c.deliverySlots.setLead(actor(), { kind: 'zone', refId: zone?.id ?? '', minutes: 3000 }));
    try {
      const far = await c.deliverySlots.book(actor(), b, { slotId: s.id, day: ahead(1) });
      expect(far).toMatchObject({ ok: false });
      expect(!far.ok && far.message).toContain('Far zone');
      await must(c.deliverySlots.book(actor(), b, { slotId: s.id, day: ahead(9) }));
    } finally {
      await must(c.deliverySlots.removeLead(actor(), lead.id));
      await db.update(schema.deliveryZones).set({ isActive: false }).where(eq(schema.deliveryZones.id, zone?.id ?? ''));
    }

    // The branch's own handling time counts too.
    await db.update(schema.deliveryMethods).set({ leadTimeMinutes: 5000 }).where(eq(schema.deliveryMethods.branchId, branchId));
    try {
      const e = await delivery();
      const slow = await c.deliverySlots.book(actor(), e, { slotId: s.id, day: ahead(2) });
      expect(!slow.ok && slow.message).toContain('branch\'s own handling time');
    } finally {
      await db.update(schema.deliveryMethods).set({ leadTimeMinutes: 0 }).where(eq(schema.deliveryMethods.branchId, branchId));
    }
  });

  it('sets, lists with names, changes and removes lead times, and refuses a bad one', async () => {
    const zone = (await db.insert(schema.deliveryZones).values({ companyId, code: code(), name: `Lead zone ${code()}` }).returning())[0];
    await delivery();
    const made = await must(c.deliverySlots.setLead(actor(), { kind: 'zone', refId: zone?.id ?? '', minutes: 90 }));
    expect(made).toMatchObject({ kind: 'zone', words: '1 hour 30 min', name: zone?.name });
    expect((await c.deliverySlots.leadTimes(companyId)).find((l) => l.id === made.id)).toMatchObject({ name: zone?.name, minutes: 90 });
    for (const bad of [{ kind: 'branch', refId: 'x', minutes: 60 }, { kind: 'zone', refId: zone?.id, minutes: 0 }, { kind: 'zone', refId: 'not-a-uuid', minutes: 60 }, { kind: 'zone', refId: randomUUID(), minutes: 60 }, { kind: 'item', refId: 'no-such-product', minutes: 60 }, { kind: 'item', refId: lastProduct, minutes: 99_999 }]) {
      expect(await c.deliverySlots.setLead(actor(), bad)).toMatchObject({ ok: false, reason: 'bad_input' });
    }
    expect(await c.deliverySlots.setLead({ ...actor(), companyId: randomUUID() }, { kind: 'zone', refId: zone?.id, minutes: 60 })).toMatchObject({ ok: false, reason: 'bad_input' });
    await must(c.deliverySlots.removeLead(actor(), made.id));
    expect((await c.deliverySlots.leadTimes(companyId)).some((l) => l.id === made.id)).toBe(false);
    expect(await c.deliverySlots.removeLead(actor(), made.id)).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await c.deliverySlots.removeLead(actor(), 'nope')).toMatchObject({ ok: false, reason: 'not_found' });
  });

  /** Gives a delivery a promised window directly (the slot rules are tested above), so lateness can be tried at any moment. */
  const windowed = async (deliveryId: string, startsInMinutes: number, endsInMinutes: number, now: Date) => {
    const s = await slot({ name: `Late ${code()}` });
    const start = new Date(now.getTime() + startsInMinutes * 60_000);
    await db.update(schema.deliveries).set({ slotId: s.id, slotDay: nairobiDay(start), windowStart: start, windowEnd: new Date(now.getTime() + endsInMinutes * 60_000), slotBookedAt: now, slotBookedBy: 'dispatcher-1' }).where(eq(schema.deliveries.id, deliveryId));
  };
  const eventsOf = async (deliveryId: string) => (await db.select().from(schema.deliverySlaEvents).where(eq(schema.deliverySlaEvents.deliveryId, deliveryId))).map((e) => e.level).sort();
  const setSla = async (atRiskMinutes: number, escalateAfterMinutes: number) => {
    const now = await c.deliverySla.settings(companyId);
    await must(c.deliverySla.setSettings(actor(), { atRiskMinutes, escalateAfterMinutes, expectedVersion: now.version }));
  };

  it('raises at risk, late and still late once each as a promised window runs out, and again changes nothing', async () => {
    await setSla(60, 60);
    const now = new Date();
    const a = await delivery();
    // The window ends in 30 minutes: at risk.
    await windowed(a, -120, 30, now);
    await c.deliverySla.scan(now);
    expect(await eventsOf(a)).toEqual(['at_risk']);
    const again = await c.deliverySla.scan(now);
    expect(again.raised).toBe(0);
    expect(await eventsOf(a)).toEqual(['at_risk']);
    // Twenty minutes after the end: late.
    await c.deliverySla.scan(new Date(now.getTime() + 50 * 60_000));
    expect(await eventsOf(a)).toEqual(['at_risk', 'late']);
    // An hour and a half after: still late, the supervisor.
    await c.deliverySla.scan(new Date(now.getTime() + 95 * 60_000));
    expect(await eventsOf(a)).toEqual(['at_risk', 'escalated', 'late']);
    const log = await db.select().from(schema.decisionLog).where(eq(schema.decisionLog.subjectId, a));
    expect(log.filter((l) => l.action.startsWith('delivery.sla_')).map((l) => l.action).sort()).toEqual(['delivery.sla_at_risk', 'delivery.sla_escalated', 'delivery.sla_late']);
    const [late] = await db.select().from(schema.deliverySlaEvents).where(eq(schema.deliverySlaEvents.deliveryId, a)).orderBy(schema.deliverySlaEvents.raisedAt);
    expect(late?.level).toBe('at_risk');
    await expect(db.update(schema.deliverySlaEvents).set({ minutesLate: 1 }).where(eq(schema.deliverySlaEvents.id, late?.id ?? ''))).rejects.toThrow();
    await expect(db.delete(schema.deliverySlaEvents).where(eq(schema.deliverySlaEvents.id, late?.id ?? ''))).rejects.toThrow();
  });

  it('does not watch a window far off, a delivery that is delivered, cancelled or returned, or one with no window', async () => {
    await setSla(60, 60);
    const now = new Date();
    const [far, done, gone, none] = [await delivery(), await delivery(), await delivery(), await delivery()];
    await windowed(far, 600, 700, now);
    await windowed(done, -300, -200, now);
    await db.update(schema.deliveries).set({ status: 'delivered', deliveredAt: new Date(now.getTime() - 250 * 60_000), closedAt: now }).where(eq(schema.deliveries.id, done));
    await windowed(gone, -300, -200, now);
    await db.update(schema.deliveries).set({ status: 'cancelled', closedAt: now }).where(eq(schema.deliveries.id, gone));
    await c.deliverySla.scan(now);
    for (const id of [far, done, gone, none]) expect(await eventsOf(id)).toEqual([]);
    expect((await c.deliverySla.overview(companyId, now)).some((l) => [far, done, gone, none].includes(l.deliveryId))).toBe(false);
  });

  it('lists what is at risk or late, the most overdue first, with the level reached, and takes an acknowledgement with a note', async () => {
    await setSla(60, 60);
    const now = new Date();
    const [riskier, later, earlier] = [await delivery(), await delivery(), await delivery()];
    await windowed(riskier, -100, 20, now);
    await windowed(later, -400, -30, now);
    await windowed(earlier, -500, -200, now);
    await c.deliverySla.scan(now);
    const list = await c.deliverySla.overview(companyId, now);
    const mine = list.filter((l) => [riskier, later, earlier].includes(l.deliveryId));
    expect(mine.map((l) => l.deliveryId)).toEqual([earlier, later, riskier]);
    expect(mine[0]).toMatchObject({ state: 'late', level: 'escalated', minutesLate: 200, acknowledged: null });
    expect(mine[1]).toMatchObject({ state: 'late', level: 'late' });
    expect(mine[2]).toMatchObject({ state: 'at_risk', level: 'at_risk', minutesLate: 0 });

    expect(await c.deliverySla.acknowledge(actor(), earlier, { note: 'no' })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await must(c.deliverySla.acknowledge(actor(), earlier, { note: 'Rider is on the way, customer called' }))).toEqual({ acknowledged: 3 });
    expect(await c.deliverySla.acknowledge(actor(), earlier, { note: 'Again for good measure' })).toMatchObject({ ok: false, reason: 'nothing_left' });
    const after = (await c.deliverySla.overview(companyId, now)).find((l) => l.deliveryId === earlier);
    expect(after?.acknowledged).toMatchObject({ by: 'dispatcher-1', note: 'Rider is on the way, customer called' });
    expect(await c.deliverySla.acknowledge(actor(), randomUUID(), { note: 'Not a delivery here' })).toMatchObject({ ok: false, reason: 'not_found' });
    expect(await c.deliverySla.acknowledge({ ...actor(), companyId: randomUUID() }, later, { note: 'Another company tries' })).toMatchObject({ ok: false, reason: 'not_found' });
    const [ack] = await db.select().from(schema.deliverySlaAcks).limit(1);
    await expect(db.update(schema.deliverySlaAcks).set({ note: 'edited' }).where(eq(schema.deliverySlaAcks.eventId, ack?.eventId ?? ''))).rejects.toThrow();

    // Given a new window, a delivery is watched afresh: its earlier acknowledgement does not cover the new promise.
    await windowed(earlier, -100, 10, now);
    await c.deliverySla.scan(now);
    const fresh = (await c.deliverySla.overview(companyId, now)).find((l) => l.deliveryId === earlier);
    expect(fresh).toMatchObject({ state: 'at_risk', acknowledged: null });
  });

  it('uses the warning time and the supervisor time that were set, each with a version', async () => {
    await setSla(10, 5);
    const now = new Date();
    const a = await delivery();
    await windowed(a, -100, 30, now);
    // Thirty minutes before the end with a ten-minute warning: not at risk yet (it has begun and is not out: that is at risk).
    expect((await c.deliverySla.settings(companyId)).atRiskMinutes).toBe(10);
    await c.deliverySla.scan(new Date(now.getTime() + 31 * 60_000));
    expect(await eventsOf(a)).toEqual(['at_risk', 'late']);
    await c.deliverySla.scan(new Date(now.getTime() + 36 * 60_000));
    expect(await eventsOf(a)).toEqual(['at_risk', 'escalated', 'late']);
    const stale = await c.deliverySla.settings(companyId);
    expect(await c.deliverySla.setSettings(actor(), { atRiskMinutes: 20, escalateAfterMinutes: 20, expectedVersion: stale.version - 1 })).toMatchObject({ ok: false, reason: 'conflict' });
    for (const bad of [{ atRiskMinutes: -1, escalateAfterMinutes: 5 }, { atRiskMinutes: 10, escalateAfterMinutes: 0 }, { atRiskMinutes: 'x', escalateAfterMinutes: 5 }]) {
      expect(await c.deliverySla.setSettings(actor(), { ...bad, expectedVersion: stale.version })).toMatchObject({ ok: false, reason: 'bad_input' });
    }
    await setSla(60, 60);
  });

  it('offers slots for a basket before any order exists, with the earliest free time and the goods\' lead time respected', async () => {
    const s = await slot({ name: `Basket ${code()}`, capacity: 1, startsAt: '00:30', endsAt: '23:00', cutoffMinutes: 0 });
    const full = await delivery();
    await must(c.deliverySlots.book(actor(), full, { slotId: s.id, day: ahead(2) }));
    const product = lastProduct;
    const days = await c.deliverySlots.offer(companyId, { branchId, from: ahead(2), days: 3, basket: { method: 'own_fleet', zone: null, lines: [{ productId: product, quantity: 2 }] } });
    expect(days[0]?.slots.find((x) => x.slotId === s.id)).toMatchObject({ available: false, why: 'This slot is full that day.' });
    expect(days[1]?.slots.find((x) => x.slotId === s.id)).toMatchObject({ available: true });
    // An item that takes three days keeps every earlier day from being offered.
    await must(c.deliverySlots.setLead(actor(), { kind: 'item', refId: product, minutes: 4320 }));
    try {
      const slow = await c.deliverySlots.offer(companyId, { branchId, from: ahead(1), days: 6, basket: { method: 'own_fleet', zone: null, lines: [{ productId: product, quantity: 1 }] } });
      expect(slow[0]?.slots.find((x) => x.slotId === s.id)?.available).toBe(false);
      expect(slow[0]?.slots.find((x) => x.slotId === s.id)?.why).toContain('will not be ready until');
      expect(slow[5]?.slots.find((x) => x.slotId === s.id)?.available).toBe(true);
    } finally {
      const l = (await c.deliverySlots.leadTimes(companyId)).find((x) => x.refId === product);
      if (l !== undefined) await must(c.deliverySlots.removeLead(actor(), l.id));
    }
  });

  it('keeps the slot a shopper chose with the order and books it when the delivery is made', async () => {
    const s = await slot({ name: `Chosen ${code()}`, capacity: 2 });
    const orderId = await orderWithSlot({ slotId: s.id, day: ahead(3) });
    expect(await c.deliverySlots.requestFor(companyId, orderId)).toMatchObject({ outcome: 'pending', slotName: s.name, day: ahead(3) });
    const doc = await c.deliveryDocuments.create(actor(), orderId, { lines: null });
    if (!doc.ok) throw new Error(doc.message);
    const held = await c.deliverySlots.heldBy(companyId, doc.data.id);
    expect(held).toMatchObject({ slotId: s.id, day: ahead(3) });
    expect((await rowOf(doc.data.id))?.slotBookedBy).toBeNull();
    expect(await c.deliverySlots.requestFor(companyId, orderId)).toMatchObject({ outcome: 'booked', note: null });
    const [req] = await db.select().from(schema.orderSlotRequests).where(eq(schema.orderSlotRequests.orderId, orderId));
    expect(req).toMatchObject({ deliveryId: doc.data.id, outcome: 'booked' });
    expect(req?.settledAt).not.toBeNull();
    // The booking counts against the slot's room like any other.
    expect((await c.deliverySlots.offer(companyId, { branchId, from: ahead(3), days: 1 }))[0]?.slots.find((x) => x.slotId === s.id)).toMatchObject({ left: 1 });
  });

  it('refuses an order whose chosen time is not free, another branch\'s slot or not a slot at all, and saves nothing', async () => {
    const s = await slot({ name: `Tight ${code()}`, capacity: 1 });
    const holder = await delivery();
    await must(c.deliverySlots.book(actor(), holder, { slotId: s.id, day: ahead(10) }));
    const orderNumber = `SL-${randomUUID()}`;
    const productId = lastProduct;
    const tryOrder = async (choice: { slotId: string; day: string }, number = orderNumber) =>
      await createOrder({ orderNumber: number, customerName: 'Wanjiru Buyer', customerEmail: `sl-${randomUUID()}@slots.test`, customerPhone: '0700123456', shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' }, items: [{ productId, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja', delivery: { method: 'own_fleet', pin: PIN, slot: choice } });
    const filled = await tryOrder({ slotId: s.id, day: ahead(10) });
    expect(filled).toMatchObject({ success: false, code: 'slot_unavailable' });
    expect(filled.error).toContain('Please choose another delivery time');
    expect(await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.orderNumber, orderNumber))).toHaveLength(0);
    // Another branch's slot is not one for this order.
    const far = await must(c.deliverySlots.create(actor(), { branchId: otherBranchId, name: `Far ${code()}`, weekdays: [1, 2, 3, 4, 5, 6, 7], startsAt: '09:00', endsAt: '12:00', capacity: 5, cutoffMinutes: 0 }));
    expect(await tryOrder({ slotId: far.id, day: ahead(10) })).toMatchObject({ success: false, code: 'slot_unavailable' });
    expect(await tryOrder({ slotId: randomUUID(), day: ahead(10) })).toMatchObject({ success: false, code: 'slot_unavailable' });
    // A free day on the same slot is fine.
    expect(await tryOrder({ slotId: s.id, day: ahead(11) })).toMatchObject({ success: true });
  });

  it('makes the delivery without the slot when it has filled since the order, says why, and never holds the delivery back', async () => {
    const s = await slot({ name: `Racing ${code()}`, capacity: 1 });
    const orderId = await orderWithSlot({ slotId: s.id, day: ahead(6) });
    const taker = await delivery();
    await must(c.deliverySlots.book(actor(), taker, { slotId: s.id, day: ahead(6) }));
    const doc = await c.deliveryDocuments.create(actor(), orderId, { lines: null });
    if (!doc.ok) throw new Error(doc.message);
    expect(await c.deliverySlots.heldBy(companyId, doc.data.id)).toBeNull();
    const asked = await c.deliverySlots.requestFor(companyId, orderId);
    expect(asked).toMatchObject({ outcome: 'unavailable' });
    expect(asked?.note).toBe('This slot is full that day.');
    // Dispatch is told on the delivery's own screen's data, and the history keeps the refusal.
    const [log] = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, doc.data.id), eq(schema.decisionLog.action, 'delivery.slot_request_unavailable')));
    expect(log).toBeDefined();
    // Making a second delivery for the same order does not try again.
    const again = await c.deliveryDocuments.create(actor(), orderId, { lines: null });
    expect(again.ok || again.reason === 'nothing_left').toBe(true);
  });

  it('judges a shopper\'s cut-off when they chose, not when the delivery is made, but never books a day that has gone', async () => {
    const s = await slot({ name: `Cutoff ${code()}`, cutoffMinutes: 3000 });
    // Tomorrow is inside the cut-off now, so the shopper could not choose it now; they chose it three days ago.
    const r = await placeOrder();
    if (!r.success || r.order === undefined) throw new Error(r.error);
    await OrderStages.move(db, r.order.id, 'payment_confirmed', 'succeeded', {});
    const orderId = r.order.id;
    await db.transaction((tx) => c.deliverySlots.recordRequest(tx, companyId, orderId, { slotId: s.id, day: ahead(1) }, { type: 'user', id: null }));
    await db.update(schema.orderSlotRequests).set({ requestedAt: new Date(Date.now() - 3 * 86_400_000) }).where(eq(schema.orderSlotRequests.orderId, orderId));
    const doc = await c.deliveryDocuments.create(actor(), orderId, { lines: null });
    if (!doc.ok) throw new Error(doc.message);
    expect(await c.deliverySlots.heldBy(companyId, doc.data.id)).toMatchObject({ day: ahead(1) });
    // A day that has already gone is not booked.
    const late = await placeOrder();
    if (!late.success || late.order === undefined) throw new Error(late.error);
    await OrderStages.move(db, late.order.id, 'payment_confirmed', 'succeeded', {});
    const lateId = late.order.id;
    await db.transaction((tx) => c.deliverySlots.recordRequest(tx, companyId, lateId, { slotId: s.id, day: addDays(today(), -2) }, { type: 'user', id: null }));
    const lateDoc = await c.deliveryDocuments.create(actor(), lateId, { lines: null });
    if (!lateDoc.ok) throw new Error(lateDoc.message);
    expect(await c.deliverySlots.heldBy(companyId, lateDoc.data.id)).toBeNull();
    expect(await c.deliverySlots.requestFor(companyId, lateId)).toMatchObject({ outcome: 'unavailable', note: 'That slot has already passed.' });
  });
});
