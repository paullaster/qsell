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
import type { DeliveryMessages as DeliveryMessagesType } from './messages';
import type { SmsSendError as SmsSendErrorType } from '@/server/ports/sms';
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
    const webpush = await import('web-push');
    const keys = webpush.generateVAPIDKeys();
    process.env.VAPID_PUBLIC_KEY = keys.publicKey;
    process.env.VAPID_PRIVATE_KEY = keys.privateKey;
    process.env.VAPID_SUBJECT = 'mailto:ops@slots.test';
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

  it('shows the dispatch board the lateness of a promised window at the company\'s own warning time, not the default', async () => {
    const now = new Date();
    const a = await delivery();
    // The window ends in 90 minutes and has begun: on its way would be needed to stay on track only inside the warning time.
    await windowed(a, 30, 90, now);
    await db.update(schema.deliveries).set({ status: 'ready', releasedAt: now, packedAt: now, readyAt: now }).where(eq(schema.deliveries.id, a));
    const stateOf = async () => (await c.deliveryRuns.board(companyId, {}, now)).ready.find((r) => r.deliveryId === a)?.promised?.state;
    await setSla(60, 60);
    expect(await stateOf()).toBe('on_track');
    await setSla(120, 60);
    expect(await stateOf()).toBe('at_risk');
    await setSla(60, 60);
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

  describe('push alerts about lateness', () => {
    interface Sent { endpoint: string; title: string; body: string; url: string; tag: string }
    const fakePush = (mode: 'up' | 'down' | 'gone' = 'up') => {
      const sent: Sent[] = [];
      const port = {
        publicKey: () => 'test-public-key',
        send: (t: { endpoint: string }, m: { title: string; body: string; url: string; tag: string }) => {
          if (mode === 'down') return Promise.reject(new Error('The push service answered 503.'));
          if (mode === 'gone') return Promise.resolve('gone' as const);
          sent.push({ endpoint: t.endpoint, title: m.title, body: m.body, url: m.url, tag: m.tag });
          return Promise.resolve('sent' as const);
        },
      };
      return { sent, port };
    };
    const made: string[] = [];
    const person = async (email: string, role = 'manager') => {
      const id = randomUUID();
      await db.insert(schema.users).values({ id, email, passwordHash: 'x', name: `Push ${id.slice(0, 4)}`, role });
      made.push(id);
      return id;
    };
    const endpoint = () => `https://push.example.test/send/${randomUUID()}`;
    const sub = (e = endpoint()) => ({ endpoint: e, p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', auth: 'tBHItJI5svbpez7KI4CCXg' });
    const setLists = async (dispatch: string, supervisor = '') => {
      const now = await c.deliverySla.settings(companyId);
      await must(c.deliverySla.setSettings(actor(), { atRiskMinutes: 60, escalateAfterMinutes: 60, notifyDispatch: dispatch, notifySupervisor: supervisor, expectedVersion: now.version }));
    };
    const pushesOf = async (deliveryId: string) => {
      const events = await db.select({ id: schema.deliverySlaEvents.id, level: schema.deliverySlaEvents.level }).from(schema.deliverySlaEvents).where(eq(schema.deliverySlaEvents.deliveryId, deliveryId));
      const rows = events.length === 0 ? [] : await db.select().from(schema.deliverySlaPushes).where(inArray(schema.deliverySlaPushes.eventId, events.map((e) => e.id)));
      return rows.map((r) => `${events.find((e) => e.id === r.eventId)?.level ?? '?'}:${r.audience}:${r.status}`).sort();
    };
    afterAll(async () => {
      // A person who became a rider stays (riders are kept for good); the rest are removed with their browsers.
      for (const id of made) await db.delete(schema.users).where(eq(schema.users.id, id)).catch(() => undefined);
    });

    it('turns alerts on for a browser, keeps one row for it, and only its owner can turn it off', async () => {
      const { DeliveryPush } = await import('./push');
      const push = new DeliveryPush(db, fakePush().port);
      const a = await person(`pa-${randomUUID()}@push.test`);
      const b = await person(`pb-${randomUUID()}@push.test`);
      const mine = sub();
      expect(await push.subscribe({ companyId, userId: a }, mine)).toEqual({ ok: true });
      expect(await push.subscribe({ companyId, userId: a }, mine)).toEqual({ ok: true });
      expect((await push.state(companyId, a)).browsers).toBe(1);
      expect(await push.unsubscribe({ companyId, userId: b }, mine.endpoint)).toEqual({ ok: true });
      expect((await push.state(companyId, a)).browsers).toBe(1);
      expect(await push.unsubscribe({ companyId, userId: a }, mine.endpoint)).toEqual({ ok: true });
      expect((await push.state(companyId, a)).browsers).toBe(0);
      expect(await push.subscribe({ companyId, userId: a }, { ...mine, endpoint: 'http://not-secure.test/x' })).toMatchObject({ ok: false });
      expect(await push.subscribe({ companyId, userId: a }, { endpoint: endpoint(), p256dh: 'x', auth: 'y' })).toMatchObject({ ok: false });
      expect(await push.subscribe({ companyId, userId: a }, null)).toMatchObject({ ok: false });
      for (let i = 0; i < 7; i += 1) await push.subscribe({ companyId, userId: a }, sub());
      expect((await push.state(companyId, a)).browsers).toBe(5);
    });

    it('says plainly when the installation has no push keys, and refuses to subscribe', async () => {
      const { DeliveryPush } = await import('./push');
      const { NoPushAdapter } = await import('@/server/adapters/push/web-push.adapter');
      const push = new DeliveryPush(db, new NoPushAdapter());
      const a = await person(`pn-${randomUUID()}@push.test`);
      expect(await push.state(companyId, a)).toEqual({ available: false, publicKey: null, browsers: 0 });
      expect(await push.subscribe({ companyId, userId: a }, sub())).toMatchObject({ ok: false });
    });

    it('queues an alert for a subscribed person on the list in the same step as the lateness, sends it once with no personal details, and not to people off the list', async () => {
      const { DeliveryPush } = await import('./push');
      const fake = fakePush();
      const push = new DeliveryPush(db, fake.port);
      const email = `Desk-${randomUUID()}@push.test`;
      const onList = await person(email);
      const offList = await person(`off-${randomUUID()}@push.test`);
      const mine = sub();
      await push.subscribe({ companyId, userId: onList }, mine);
      await push.subscribe({ companyId, userId: offList }, sub());
      await setLists(email);
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      await c.deliverySla.scan(now);
      expect(await pushesOf(a)).toEqual(['at_risk:staff:queued']);
      await push.flush(500);
      const mineSent = fake.sent.filter((x) => x.endpoint === mine.endpoint);
      expect(mineSent).toHaveLength(1);
      expect(mineSent[0]?.title).toMatch(/^Delivery DLV-.* is at risk$/);
      expect(mineSent[0]?.url).toBe('/admin/delivery/late');
      expect(`${mineSent[0]?.title ?? ""} ${mineSent[0]?.body ?? ""}`).not.toMatch(/0700|Test Rd|Wanjiru|@/i);
      expect(await pushesOf(a)).toEqual(['at_risk:staff:sent']);
      await push.flush(500);
      expect(fake.sent.filter((x) => x.endpoint === mine.endpoint)).toHaveLength(1);
    });

    it('sends the supervisors the escalation and nobody else, and the rider whose run holds the delivery the first two levels', async () => {
      const { DeliveryPush } = await import('./push');
      const fake = fakePush();
      const push = new DeliveryPush(db, fake.port);
      const boss = `boss-${randomUUID()}@push.test`;
      const bossId = await person(boss);
      const bossSub = sub();
      await push.subscribe({ companyId, userId: bossId }, bossSub);
      const riderUser = await person(`rider-${randomUUID()}@push.test`, 'super_admin');
      const riderSub = sub();
      await push.subscribe({ companyId, userId: riderUser }, riderSub);
      const kinds = await c.deliveryRiders.settings(companyId);
      await c.deliveryRiders.setKinds(actor(), { allowStaff: true, allowSeparate: true, expectedVersion: kinds.version });
      const rider = await c.deliveryRiders.addStaff(actor(), { userId: riderUser });
      if (!rider.ok) throw new Error(rider.message);
      await setLists('', boss);
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      const run = await must(c.deliveryRuns.create(actor(), { branchId, runDate: nairobiDay(now), riderId: rider.data.id }));
      // Readiness is tested with the runs; here the delivery only needs to be a live stop of the rider's run.
      await db.insert(schema.deliveryRunStops).values({ runId: run.id, deliveryId: a, sequence: 1, addedBy: 'dispatcher-1' });
      await c.deliverySla.scan(now);
      await c.deliverySla.scan(new Date(now.getTime() + 50 * 60_000));
      await c.deliverySla.scan(new Date(now.getTime() + 95 * 60_000));
      expect(await pushesOf(a)).toEqual(['at_risk:rider:queued', 'escalated:staff:queued', 'late:rider:queued']);
      await push.flush(500);
      // Other deliveries left late by earlier tests are alerted too; this one is told apart by its tag.
      const ours = fake.sent.filter((x) => x.tag === `delivery-${a}`);
      expect(ours.filter((x) => x.endpoint === riderSub.endpoint).map((x) => x.url)).toEqual(['/rider', '/rider']);
      expect(ours.filter((x) => x.endpoint === bossSub.endpoint)).toHaveLength(1);
      expect(ours).toHaveLength(3);
    });

    it('forgets a browser the push service says is gone, and keeps an alert that could not be sent to try again after a wait', async () => {
      const { DeliveryPush } = await import('./push');
      const email = `gone-${randomUUID()}@push.test`;
      const user = await person(email);
      const mine = sub();
      await new DeliveryPush(db, fakePush().port).subscribe({ companyId, userId: user }, mine);
      await setLists(email);
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      const down = new DeliveryPush(db, fakePush('down').port);
      expect(await down.flush(500)).toBe(0);
      expect(await pushesOf(a)).toEqual(['at_risk:staff:failed']);
      const [failed] = await db.select().from(schema.deliverySlaPushes).where(eq(schema.deliverySlaPushes.status, 'failed'));
      expect(failed?.attempts).toBe(1);
      expect(failed?.lastError).toContain('503');
      expect(new Date(failed?.nextTryAt ?? 0).getTime()).toBeGreaterThan(Date.now());
      // Not due yet: nothing is tried; once the wait is over it goes.
      const up = fakePush();
      const again = new DeliveryPush(db, up.port);
      expect(await again.flush(500)).toBe(0);
      await db.update(schema.deliverySlaPushes).set({ nextTryAt: new Date(Date.now() - 1000) }).where(eq(schema.deliverySlaPushes.status, 'failed'));
      expect(await again.flush(500)).toBeGreaterThanOrEqual(1);
      expect(up.sent.some((x) => x.endpoint === mine.endpoint)).toBe(true);
      // A later alert to a browser that has gone removes the browser.
      const b = await delivery();
      await windowed(b, -120, 30, now);
      await c.deliverySla.scan(now);
      await new DeliveryPush(db, fakePush('gone').port).flush(500);
      expect((await new DeliveryPush(db, fakePush().port).state(companyId, user)).browsers).toBe(0);
    });
  });

  describe('text messages about lateness', () => {
    const setTexts = async (over: { dispatch?: string; supervisor?: string; rider?: boolean; mails?: [string, string] } = {}) => {
      const now = await c.deliverySla.settings(companyId);
      return await c.deliverySla.setSettings(actor(), { atRiskMinutes: 60, escalateAfterMinutes: 60, notifyDispatch: over.mails?.[0] ?? '', notifySupervisor: over.mails?.[1] ?? '', notifyDispatchPhones: over.dispatch ?? '', notifySupervisorPhones: over.supervisor ?? '', textTheRider: over.rider ?? false, expectedVersion: now.version });
    };
    const textsOf = async (deliveryId: string) => {
      const events = await db.select({ id: schema.deliverySlaEvents.id, level: schema.deliverySlaEvents.level }).from(schema.deliverySlaEvents).where(eq(schema.deliverySlaEvents.deliveryId, deliveryId));
      const rows = events.length === 0 ? [] : await db.select().from(schema.deliverySlaTexts).where(inArray(schema.deliverySlaTexts.eventId, events.map((e) => e.id)));
      return rows.map((r) => `${events.find((e) => e.id === r.eventId)?.level ?? '?'}:${r.audience}:${r.recipient}:${r.status}`).sort();
    };
    /** Texts go through a connection of the company's own, with the provider's answer decided here. */
    const sent: { to: string; text: string }[] = [];
    let providerAnswer: () => Response = () => new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 101, messageId: 'm1' }] } }), { status: 201 });
    const texter = async (name: string) => {
      const { SmsAccounts } = await import('@/server/domains/sms/accounts');
      const { DeliverySlaTexts } = await import('./sla-texts');
      const accounts = new SmsAccounts(db, c.decisionLog, (_u: string, init: RequestInit) => {
        const form = new URLSearchParams(init.body as string);
        sent.push({ to: form.get('to') ?? '', text: form.get('message') ?? '' });
        return Promise.resolve(providerAnswer());
      });
      const made = await accounts.create(actor(), { name, adapter: 'africastalking', username: 'texts', apiKey: 'k'.repeat(30) });
      if (!made.ok) throw new Error(made.message);
      return { accounts, texts: new DeliverySlaTexts(db, accounts, c.companySettings), accountId: made.data.id };
    };
    const clearAccounts = () => db.delete(schema.smsProviderAccounts).where(eq(schema.smsProviderAccounts.companyId, companyId));
    beforeEach(async () => {
      sent.length = 0;
      providerAnswer = () => new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 101, messageId: 'm1' }] } }), { status: 201 });
      await clearAccounts();
    });
    afterAll(clearAccounts);

    it('keeps the numbers with their country code, once each, and refuses one that is not a mobile number', async () => {
      const saved = await setTexts({ dispatch: '0712 345 678, +254712345678; 0722111222', supervisor: '0733 000 111' });
      expect(saved).toMatchObject({ ok: true, data: { notifyDispatchPhones: ['+254712345678', '+254722111222'], notifySupervisorPhones: ['+254733000111'], textTheRider: false } });
      expect(await setTexts({ dispatch: '0712345678, nonsense' })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('nonsense') as string });
      expect((await c.deliverySla.settings(companyId)).notifyDispatchPhones).toEqual(['+254712345678', '+254722111222']);
    });

    it('queues one text for each number and level in the same step as the lateness: dispatchers for the first two levels, supervisors for the third, and once only', async () => {
      await setTexts({ dispatch: '0711000001, 0711000002', supervisor: '0711000009' });
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      await c.deliverySla.scan(now);
      await c.deliverySla.scan(new Date(now.getTime() + 50 * 60_000));
      await c.deliverySla.scan(new Date(now.getTime() + 95 * 60_000));
      expect(await textsOf(a)).toEqual([
        'at_risk:staff:+254711000001:queued', 'at_risk:staff:+254711000002:queued',
        'escalated:staff:+254711000009:queued',
        'late:staff:+254711000001:queued', 'late:staff:+254711000002:queued',
      ]);
    });

    it('queues nothing when no number is set, and changing the list later does not change who was texted', async () => {
      await setTexts({});
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      expect(await textsOf(a)).toEqual([]);
      await setTexts({ dispatch: '0711000003' });
      const b = await delivery();
      await windowed(b, -120, 30, now);
      await c.deliverySla.scan(now);
      await setTexts({ dispatch: '0711000004' });
      expect(await textsOf(b)).toEqual(['at_risk:staff:+254711000003:queued']);
    });

    it('sends each text once through the default connection, with the delivery and the time promised, and nothing of the customer', async () => {
      const t = await texter(`Texts ${randomUUID().slice(0, 6)}`);
      await setTexts({ dispatch: '0711000005' });
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      await t.texts.flush(500);
      const mine = sent.filter((m) => m.to === '+254711000005');
      expect(mine).toHaveLength(1);
      expect(mine[0]?.text).toMatch(/^Delivery DLV-\S+ is at risk of being late\. Promised /);
      expect(mine[0]?.text.length).toBeLessThanOrEqual(160);
      expect(mine[0]?.text).not.toMatch(/0700|Test Rd|Wanjiru/i);
      expect(await textsOf(a)).toEqual(['at_risk:staff:+254711000005:sent']);
      await t.texts.flush(500);
      expect(sent.filter((m) => m.to === '+254711000005')).toHaveLength(1);
      const shown = (await c.deliverySla.overview(companyId, now)).find((l) => l.deliveryId === a);
      expect(shown?.texts).toEqual({ sent: 1, waiting: 0, failed: 0 });
    });

    it('waits when no SMS provider is connected, says why, and sends when one is', async () => {
      const { SmsAccounts } = await import('@/server/domains/sms/accounts');
      const { DeliverySlaTexts } = await import('./sla-texts');
      await setTexts({ dispatch: '0711000006' });
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      const none = new DeliverySlaTexts(db, new SmsAccounts(db, c.decisionLog, undefined), c.companySettings);
      expect(await none.flush(500)).toBe(0);
      const [waiting] = await db.select().from(schema.deliverySlaTexts).where(eq(schema.deliverySlaTexts.recipient, '+254711000006'));
      expect(waiting?.status).toBe('failed');
      expect(waiting?.lastError).toContain('No SMS provider is set up');
      expect((waiting?.attempts ?? 9)).toBeLessThan(5);
      expect(await c.smsAccounts.defaultName(companyId)).toBeNull();
      const t = await texter(`Later ${randomUUID().slice(0, 6)}`);
      await db.update(schema.deliverySlaTexts).set({ nextTryAt: new Date(Date.now() - 1000) }).where(eq(schema.deliverySlaTexts.recipient, '+254711000006'));
      expect(await t.texts.flush(500)).toBeGreaterThanOrEqual(1);
      expect(sent.some((m) => m.to === '+254711000006')).toBe(true);
    });

    it('does not try again a refusal that asking again cannot change, and tries again one that can', async () => {
      const t = await texter(`Refuse ${randomUUID().slice(0, 6)}`);
      await setTexts({ dispatch: '0711000007' });
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      providerAnswer = () => new Response(JSON.stringify({ SMSMessageData: { Recipients: [{ statusCode: 405 }] } }), { status: 201 });
      expect(await t.texts.flush(500)).toBe(0);
      const [refused] = await db.select().from(schema.deliverySlaTexts).where(eq(schema.deliverySlaTexts.recipient, '+254711000007'));
      expect(refused).toMatchObject({ status: 'failed', attempts: 5 });
      expect(refused?.lastError).toContain('balance');
      expect((await c.deliverySla.overview(companyId, now)).find((l) => l.deliveryId === a)?.texts).toEqual({ sent: 0, waiting: 0, failed: 1 });
      const b = await delivery();
      await windowed(b, -120, 30, now);
      await setTexts({ dispatch: '0711000008' });
      await c.deliverySla.scan(now);
      providerAnswer = () => new Response('{}', { status: 503 });
      await t.texts.flush(500);
      const [again] = await db.select().from(schema.deliverySlaTexts).where(eq(schema.deliverySlaTexts.recipient, '+254711000008'));
      expect(again).toMatchObject({ status: 'failed', attempts: 1 });
      expect(new Date(again?.nextTryAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    });

    it('drops a text that has waited too long to be of use', async () => {
      const t = await texter(`Stale ${randomUUID().slice(0, 6)}`);
      await setTexts({ dispatch: '0711000010' });
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      await db.update(schema.deliverySlaTexts).set({ createdAt: new Date(Date.now() - 4 * 3600_000) }).where(eq(schema.deliverySlaTexts.recipient, '+254711000010'));
      expect(await t.texts.flush(500)).toBe(0);
      expect(sent.filter((m) => m.to === '+254711000010')).toHaveLength(0);
      const [row] = await db.select().from(schema.deliverySlaTexts).where(eq(schema.deliverySlaTexts.recipient, '+254711000010'));
      expect(row?.lastError).toContain('too late');
    });

    it('texts the rider of the run on the number saved for them, for the first two levels only, and only when the company chose it', async () => {
      const t = await texter(`Rider ${randomUUID().slice(0, 6)}`);
      const user = randomUUID();
      await db.insert(schema.users).values({ id: user, email: `txt-${user}@texts.test`, passwordHash: 'x', name: 'Texted Rider', role: 'super_admin' });
      const kinds = await c.deliveryRiders.settings(companyId);
      await c.deliveryRiders.setKinds(actor(), { allowStaff: true, allowSeparate: true, expectedVersion: kinds.version });
      const rider = await c.deliveryRiders.addStaff(actor(), { userId: user });
      if (!rider.ok) throw new Error(rider.message);
      await db.update(schema.deliveryRiders).set({ phone: '+254744000111' }).where(eq(schema.deliveryRiders.id, rider.data.id));
      const now = new Date();
      const onRun = async () => {
        const d = await delivery();
        await windowed(d, -120, 30, now);
        const run = await must(c.deliveryRuns.create(actor(), { branchId, runDate: nairobiDay(now), riderId: rider.data.id }));
        await db.insert(schema.deliveryRunStops).values({ runId: run.id, deliveryId: d, sequence: 1, addedBy: 'dispatcher-1' });
        return d;
      };
      await setTexts({ rider: false });
      const off = await onRun();
      await c.deliverySla.scan(now);
      expect(await textsOf(off)).toEqual([]);
      await setTexts({ rider: true, supervisor: '0711000011' });
      const on = await onRun();
      await c.deliverySla.scan(now);
      await c.deliverySla.scan(new Date(now.getTime() + 50 * 60_000));
      await c.deliverySla.scan(new Date(now.getTime() + 95 * 60_000));
      expect(await textsOf(on)).toEqual(['at_risk:rider:+254744000111:queued', 'escalated:staff:+254711000011:queued', 'late:rider:+254744000111:queued']);
      // The setting is read when a level is raised, so the delivery planned while it was off is texted for the levels raised after it was turned on.
      await t.texts.flush(500);
      expect(await textsOf(on)).toEqual(['at_risk:rider:+254744000111:sent', 'escalated:staff:+254711000011:sent', 'late:rider:+254744000111:sent']);
      expect(await textsOf(off)).toEqual(['escalated:staff:+254711000011:sent', 'late:rider:+254744000111:sent']);
    });
  });

  describe('text messages to customers', () => {
    const setCustomerTexts = async (enabled: boolean, kinds: string[]) => {
      const now = await c.deliveryTextSettings.get(companyId);
      return await c.deliveryTextSettings.set(actor(), { enabled, kinds, expectedVersion: now.version });
    };
    const messagesOf = async (deliveryId: string) => (await db.select().from(schema.deliveryMessages).where(eq(schema.deliveryMessages.deliveryId, deliveryId))).map((m) => `${m.kind}:${m.channel}:${m.status}`).sort();
    const enqueue = async (deliveryId: string, kind: 'out_for_delivery' | 'delivered' | 'attempt_failed', key = `${deliveryId}:${kind}:0`) => {
      const row = await rowOf(deliveryId);
      if (row === undefined) throw new Error('no delivery');
      await db.transaction((tx) => c.deliveryMessages.enqueueIn(tx, { companyId, orderId: row.orderId, deliveryId, kind, key }));
    };
    const sentMail: string[] = [];
    const texted: { to: string; text: string }[] = [];
    const sender = (mode: 'up' | 'none' | 'refused' | 'down') => ({
      settings: c.deliveryTextSettings,
      sender: () => Promise.resolve(mode === 'none' ? null : { send: (m: { to: string; text: string }) => { if (mode === 'refused') return Promise.reject(new SmsSendError('The Africa\'s Talking account has no balance. Top it up and try again.', false)); if (mode === 'down') return Promise.reject(new SmsSendError('The SMS provider had a problem. Try again in a moment.', true)); texted.push(m); return Promise.resolve({ providerMessageId: null }); } }),
    });
    const flusher = (mode: 'up' | 'none' | 'refused' | 'down') => new DeliveryMessagesClass(db, { name: 'test', send: (m: { to: string }) => { sentMail.push(m.to); return Promise.resolve({ messageId: 'x', provider: 'test' }); } }, c.companySettings, { tokenFor: () => Promise.resolve('tok123') }, sender(mode));
    let DeliveryMessagesClass: typeof DeliveryMessagesType;
    let SmsSendError: typeof SmsSendErrorType;
    beforeAll(async () => {
      ({ DeliveryMessages: DeliveryMessagesClass } = await import('./messages'));
      ({ SmsSendError } = await import('@/server/ports/sms'));
    });
    beforeEach(() => {
      sentMail.length = 0;
      texted.length = 0;
    });
    afterAll(async () => {
      await setCustomerTexts(false, ['out_for_delivery', 'delivered', 'attempt_failed']);
    });

    it('is off until the company turns it on, then keeps the choice with a version, and refuses nonsense', async () => {
      expect(await c.deliveryTextSettings.get(companyId)).toMatchObject({ enabled: false, kinds: ['out_for_delivery', 'delivered', 'attempt_failed', 'ready_for_collection'] });
      expect(await setCustomerTexts(true, [])).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await setCustomerTexts(true, ['nonsense'])).toMatchObject({ ok: false, reason: 'bad_input' });
      const on = await setCustomerTexts(true, ['delivered', 'out_for_delivery']);
      expect(on).toMatchObject({ ok: true, data: { enabled: true, kinds: ['out_for_delivery', 'delivered'] } });
      const stale = await c.deliveryTextSettings.set(actor(), { enabled: false, kinds: [], expectedVersion: 1 });
      expect(stale).toMatchObject({ ok: false, reason: 'conflict' });
      expect(await setCustomerTexts(false, [])).toMatchObject({ ok: true, data: { enabled: false } });
    });

    it('queues only the email while texting is off, and the text as its own row when it is on for that kind', async () => {
      await setCustomerTexts(false, ['out_for_delivery']);
      const a = await delivery();
      await enqueue(a, 'out_for_delivery');
      expect(await messagesOf(a)).toEqual(['out_for_delivery:email:queued']);
      await setCustomerTexts(true, ['out_for_delivery']);
      const b = await delivery();
      await enqueue(b, 'out_for_delivery');
      await enqueue(b, 'out_for_delivery');
      await enqueue(b, 'delivered');
      expect(await messagesOf(b)).toEqual(['delivered:email:queued', 'out_for_delivery:email:queued', 'out_for_delivery:sms:queued']);
      const [sms] = await db.select().from(schema.deliveryMessages).where(eq(schema.deliveryMessages.messageKey, `${b}:out_for_delivery:0:sms`));
      expect(sms?.recipient).toBe('+254700123456');
    });

    it('sends the text through the default SMS connection with the facts, the code and the link, and nothing of the address or the phone', async () => {
      await setCustomerTexts(true, ['out_for_delivery']);
      const a = await delivery();
      await db.update(schema.deliveries).set({ handoverCode: '482913' }).where(eq(schema.deliveries.id, a));
      await enqueue(a, 'out_for_delivery');
      await flusher('up').flush(500);
      const mineText = texted.find((t) => t.to === '+254700123456' && t.text.includes('482913'));
      expect(mineText).toBeDefined();
      expect(mineText?.text).toMatch(/on its way/);
      expect(mineText?.text).toContain('/track/tok123');
      expect(mineText?.text).not.toMatch(/Test Rd|0700123456/);
      expect((mineText?.text ?? '').length).toBeLessThanOrEqual(306);
      expect(await messagesOf(a)).toEqual(['out_for_delivery:email:sent', 'out_for_delivery:sms:sent']);
      expect(sentMail.length).toBeGreaterThan(0);
      texted.length = 0;
      await flusher('up').flush(500);
      expect(texted.filter((t) => t.text.includes('482913'))).toHaveLength(0);
    });

    it('does not text a customer with no usable mobile number, and the email still goes', async () => {
      await setCustomerTexts(true, ['delivered']);
      const a = await delivery();
      const row = await rowOf(a);
      await db.update(schema.orders).set({ customerPhone: 'call me' }).where(eq(schema.orders.id, row?.orderId ?? ''));
      await enqueue(a, 'delivered');
      expect(await messagesOf(a)).toEqual(['delivered:email:queued', 'delivered:sms:skipped']);
      const [skipped] = await db.select().from(schema.deliveryMessages).where(and(eq(schema.deliveryMessages.deliveryId, a), eq(schema.deliveryMessages.channel, 'sms')));
      expect(skipped?.lastError).toContain('no usable mobile number');
    });

    it('waits when no SMS provider is connected and says why, never holding back the email', async () => {
      await setCustomerTexts(true, ['attempt_failed']);
      const a = await delivery();
      await enqueue(a, 'attempt_failed');
      await flusher('none').flush(500);
      const rows = await db.select().from(schema.deliveryMessages).where(eq(schema.deliveryMessages.deliveryId, a));
      const sms = rows.find((r) => r.channel === 'sms');
      expect(sms).toMatchObject({ status: 'failed', attempts: 1 });
      expect(sms?.lastError).toContain('No SMS provider is set up');
      expect(rows.find((r) => r.channel === 'email')?.status).toBe('sent');
    });

    it('does not repeat a refusal asking again cannot change, and tries again a fault after a wait', async () => {
      await setCustomerTexts(true, ['out_for_delivery']);
      const a = await delivery();
      await enqueue(a, 'out_for_delivery');
      await flusher('refused').flush(500);
      const [refused] = await db.select().from(schema.deliveryMessages).where(and(eq(schema.deliveryMessages.deliveryId, a), eq(schema.deliveryMessages.channel, 'sms')));
      expect(refused).toMatchObject({ status: 'failed', attempts: 5 });
      expect(refused?.lastError).toContain('balance');
      const b = await delivery();
      await enqueue(b, 'out_for_delivery');
      await flusher('down').flush(500);
      const [again] = await db.select().from(schema.deliveryMessages).where(and(eq(schema.deliveryMessages.deliveryId, b), eq(schema.deliveryMessages.channel, 'sms')));
      expect(again).toMatchObject({ status: 'failed', attempts: 1 });
      expect(new Date(again?.nextTryAt ?? 0).getTime()).toBeGreaterThan(Date.now());
    });

    it('keeps quiet hours, refuses half a pair, and holds a night text for the morning while the email goes at once', async () => {
      const now = await c.deliveryTextSettings.get(companyId);
      expect(await c.deliveryTextSettings.set(actor(), { enabled: true, kinds: ['out_for_delivery'], quietFrom: '21:00', quietUntil: '', expectedVersion: now.version })).toMatchObject({ ok: false, reason: 'bad_input' });
      expect(await c.deliveryTextSettings.set(actor(), { enabled: true, kinds: ['out_for_delivery'], quietFrom: '08:00', quietUntil: '08:00', expectedVersion: now.version })).toMatchObject({ ok: false, reason: 'bad_input' });
      const saved = await c.deliveryTextSettings.set(actor(), { enabled: true, kinds: ['out_for_delivery'], quietFrom: '21:00', quietUntil: '07:00', expectedVersion: now.version });
      expect(saved).toMatchObject({ ok: true, data: { quiet: { from: 1260, until: 420 } } });
      expect((await c.deliveryTextSettings.get(companyId)).quiet).toEqual({ from: 1260, until: 420 });
      const a = await delivery();
      await db.update(schema.deliveries).set({ handoverCode: '735190' }).where(eq(schema.deliveries.id, a));
      await enqueue(a, 'out_for_delivery');
      // 23:00 in Nairobi: the email goes, the text waits.
      await flusher('up').flush(500, new Date('2030-01-01T20:00:00Z'));
      expect(texted.filter((t) => t.text.includes('735190'))).toHaveLength(0);
      const [held] = await db.select().from(schema.deliveryMessages).where(and(eq(schema.deliveryMessages.deliveryId, a), eq(schema.deliveryMessages.channel, 'sms')));
      expect(held).toMatchObject({ status: 'queued', attempts: 0, lastError: 'Held until the quiet hours end.' });
      expect(held?.nextTryAt.toISOString()).toBe('2030-01-02T04:00:00.000Z');
      expect((await messagesOf(a)).sort()).toEqual(['out_for_delivery:email:sent', 'out_for_delivery:sms:queued']);
      // Still night a little later: nothing is due, so nothing goes. At 07:00 it goes, and the note is cleared.
      await flusher('up').flush(500, new Date('2030-01-02T03:59:00Z'));
      expect(texted.filter((t) => t.text.includes('735190'))).toHaveLength(0);
      await flusher('up').flush(500, new Date('2030-01-02T04:00:00Z'));
      expect(texted.filter((t) => t.text.includes('735190'))).toHaveLength(1);
      expect(await messagesOf(a)).toEqual(['out_for_delivery:email:sent', 'out_for_delivery:sms:sent']);
      await setCustomerTexts(false, []);
    });
  });

  describe('mail about lateness', () => {
    const setMail = async (dispatch: string, supervisor: string) => {
      const now = await c.deliverySla.settings(companyId);
      await must(c.deliverySla.setSettings(actor(), { atRiskMinutes: 60, escalateAfterMinutes: 60, notifyDispatch: dispatch, notifySupervisor: supervisor, expectedVersion: now.version }));
    };
    const noticesOf = async (deliveryId: string) => {
      const events = await db.select({ id: schema.deliverySlaEvents.id, level: schema.deliverySlaEvents.level }).from(schema.deliverySlaEvents).where(eq(schema.deliverySlaEvents.deliveryId, deliveryId));
      const rows = events.length === 0 ? [] : await db.select().from(schema.deliverySlaNotices).where(inArray(schema.deliverySlaNotices.eventId, events.map((e) => e.id)));
      return rows.map((r) => `${events.find((e) => e.id === r.eventId)?.level ?? '?'}:${r.recipient}:${r.status}`).sort();
    };
    const mailer = (fail = false) => {
      const sent: { to: string; subject: string; text: string }[] = [];
      return { sent, port: { name: 'test', send: (m: { to: string; subject: string; text?: string }) => (fail ? Promise.reject(new Error('mail server down')) : (sent.push({ to: m.to, subject: m.subject, text: m.text ?? '' }), Promise.resolve({ messageId: 'x', provider: 'test' }))) } };
    };

    it('queues one mail for each address and level in the same step as the lateness, the dispatchers for the first two levels and the supervisors for the third, and once only', async () => {
      await setMail('Ops@shop.test, desk@shop.test', 'boss@shop.test');
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      expect(await noticesOf(a)).toEqual(['at_risk:desk@shop.test:queued', 'at_risk:ops@shop.test:queued']);
      await c.deliverySla.scan(now);
      await c.deliverySla.scan(new Date(now.getTime() + 50 * 60_000));
      await c.deliverySla.scan(new Date(now.getTime() + 95 * 60_000));
      expect(await noticesOf(a)).toEqual(['at_risk:desk@shop.test:queued', 'at_risk:ops@shop.test:queued', 'escalated:boss@shop.test:queued', 'late:desk@shop.test:queued', 'late:ops@shop.test:queued']);
    });

    it('queues nothing when nobody is on the list, and changing the list later does not change who was told', async () => {
      await setMail('', '');
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      expect(await noticesOf(a)).toEqual([]);
      await setMail('first@shop.test', '');
      const b = await delivery();
      await windowed(b, -120, 30, now);
      await c.deliverySla.scan(now);
      await setMail('second@shop.test', '');
      expect(await noticesOf(b)).toEqual(['at_risk:first@shop.test:queued']);
    });

    it('sends what is due once, with the delivery, the window and the screen to open, and sends nothing a second time', async () => {
      const { DeliverySlaNotices } = await import('./sla-notices');
      await setMail('flush-one@shop.test', '');
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await c.deliverySla.scan(now);
      const mail = mailer();
      const notices = new DeliverySlaNotices(db, mail.port, c.companySettings);
      await notices.flush(50);
      const mine = mail.sent.filter((m) => m.to === 'flush-one@shop.test');
      expect(mine).toHaveLength(1);
      expect(mine[0]?.subject).toMatch(/^At risk: delivery DLV-/);
      expect(mine[0]?.text).toContain('/admin/delivery/late');
      expect(mine[0]?.text).not.toMatch(/0700|street|Test Rd/i);
      expect(await noticesOf(a)).toEqual(['at_risk:flush-one@shop.test:sent']);
      expect((await c.deliverySla.overview(companyId, now)).find((l) => l.deliveryId === a)?.mails).toEqual({ sent: 1, waiting: 0, failed: 0 });
      await notices.flush(50);
      expect(mail.sent.filter((m) => m.to === 'flush-one@shop.test')).toHaveLength(1);
    });

    it('keeps a mail that could not be sent, tries again after a wait, without stopping the scan', async () => {
      const { DeliverySlaNotices } = await import('./sla-notices');
      const down = `down-${code().toLowerCase()}@shop.test`;
      await setMail(down, '');
      const now = new Date();
      const a = await delivery();
      await windowed(a, -120, 30, now);
      await expect(c.deliverySla.scan(now)).resolves.toMatchObject({ raised: expect.any(Number) as number });
      const broken = new DeliverySlaNotices(db, mailer(true).port, c.companySettings);
      await broken.flush(50);
      expect(await noticesOf(a)).toEqual([`at_risk:${down}:failed`]);
      const [failed] = await db.select().from(schema.deliverySlaNotices).where(eq(schema.deliverySlaNotices.recipient, down));
      expect(failed).toMatchObject({ attempts: 1, lastError: 'mail server down' });
      expect(failed?.nextTryAt.getTime()).toBeGreaterThan(Date.now());
      // Not yet due: nothing is tried. Made due, and the mail server back: it goes.
      const up = mailer();
      await new DeliverySlaNotices(db, up.port, c.companySettings).flush(50);
      expect(up.sent.filter((m) => m.to === down)).toHaveLength(0);
      await db.update(schema.deliverySlaNotices).set({ nextTryAt: new Date(Date.now() - 1000) }).where(eq(schema.deliverySlaNotices.recipient, down));
      await new DeliverySlaNotices(db, up.port, c.companySettings).flush(50);
      expect(up.sent.filter((m) => m.to === down)).toHaveLength(1);
      expect(await noticesOf(a)).toEqual([`at_risk:${down}:sent`]);
    });

    it('refuses a list that has something that is not an address, or too many, and keeps the last list', async () => {
      await setMail('keep@shop.test', 'keep-boss@shop.test');
      const now = await c.deliverySla.settings(companyId);
      expect(await c.deliverySla.setSettings(actor(), { atRiskMinutes: 60, escalateAfterMinutes: 60, notifyDispatch: 'keep@shop.test, nobody', notifySupervisor: '', expectedVersion: now.version })).toMatchObject({ ok: false, reason: 'bad_input', message: expect.stringContaining('Dispatchers') as string });
      expect(await c.deliverySla.setSettings(actor(), { atRiskMinutes: 60, escalateAfterMinutes: 60, notifyDispatch: '', notifySupervisor: 'nobody', expectedVersion: now.version })).toMatchObject({ ok: false, message: expect.stringContaining('Supervisors') as string });
      expect(await c.deliverySla.settings(companyId)).toMatchObject({ notifyDispatch: ['keep@shop.test'], notifySupervisor: ['keep-boss@shop.test'] });
    });
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
    // The customer is told in the same step, once.
    const told = await db.select({ kind: schema.deliveryMessages.kind }).from(schema.deliveryMessages).where(eq(schema.deliveryMessages.deliveryId, doc.data.id));
    expect(told.filter((m) => m.kind === 'slot_not_kept')).toHaveLength(1);
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

  it('lets a company turn the shopper\'s choice of delivery time off: a time sent anyway is refused and nothing is saved, and turning it back on restores it', async () => {
    // With nothing set the shop behaves as it always did: shoppers choose.
    const first = await c.deliverySlots.shopperChoice(companyId);
    expect(first.enabled).toBe(true);
    const s = await slot({ name: `Choice ${code()}`, capacity: 5 });
    const productId = lastProduct;
    const place = async (number: string) =>
      await createOrder({ orderNumber: number, customerName: 'Wanjiru Buyer', customerEmail: `sl-${randomUUID()}@slots.test`, customerPhone: '0700123456', shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' }, items: [{ productId, quantity: 1 }], currency: 'KES', paymentMethod: 'mpesa_daraja', delivery: { method: 'own_fleet', pin: PIN, slot: { slotId: s.id, day: ahead(12) } } });
    // Bad input and a stale version change nothing.
    expect(await c.deliverySlots.setShopperChoice(actor(), { enabled: 'no', expectedVersion: first.version })).toMatchObject({ ok: false, reason: 'bad_input' });
    expect(await c.deliverySlots.setShopperChoice(actor(), { enabled: false, expectedVersion: first.version + 5 })).toMatchObject({ ok: false, reason: 'conflict' });
    expect((await c.deliverySlots.shopperChoice(companyId)).enabled).toBe(true);
    const off = await must(c.deliverySlots.setShopperChoice(actor(), { enabled: false, expectedVersion: first.version }));
    expect(off).toMatchObject({ enabled: false, version: first.version + 1 });
    // The old version cannot flip it again.
    expect(await c.deliverySlots.setShopperChoice(actor(), { enabled: true, expectedVersion: first.version })).toMatchObject({ ok: false, reason: 'conflict' });
    const number = `SL-${randomUUID()}`;
    const refused = await place(number);
    expect(refused).toMatchObject({ success: false, code: 'slot_unavailable' });
    expect(refused.error).toContain('without a time');
    expect(await db.select({ id: schema.orders.id }).from(schema.orders).where(eq(schema.orders.orderNumber, number))).toHaveLength(0);
    // An order with no time is unaffected, and staff can still book a slot for a delivery.
    const holder = await delivery();
    await must(c.deliverySlots.book(actor(), holder, { slotId: s.id, day: ahead(12) }));
    const [log] = await db.select().from(schema.decisionLog).where(and(eq(schema.decisionLog.subjectId, companyId), eq(schema.decisionLog.action, 'delivery.shopper_choice_changed')));
    expect(log?.inputs).toMatchObject({ before: true, after: false });
    const on = await must(c.deliverySlots.setShopperChoice(actor(), { enabled: true, expectedVersion: off.version }));
    expect(on.enabled).toBe(true);
    expect(await place(`SL-${randomUUID()}`)).toMatchObject({ success: true });
  });
});
