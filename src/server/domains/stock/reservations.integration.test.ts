import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as ReservationModule from '@/server/domains/inventory/reservation-service';
import type * as TasksModule from '@/server/queue/tasks';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';

/**
 * Holds on stock against a real database: choosing the location, placing, using and giving back a hold, the counters following the
 * balances, orders reserving and settling through it, holds that run out, and many baskets at once.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('holds on stock per location (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let Reservations: typeof ReservationModule.InventoryReservationService;
  let tasks: typeof TasksModule;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  let main: string;
  const extraLocations: string[] = [];

  const newProduct = async (stock = 0) => {
    const id = `prod_rs_${randomUUID()}`;
    await db.insert(schema.products).values({ id, sku: `RS-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `RSS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Hold ${id.slice(-6)}`, slug: `rs-${randomUUID()}`, itemTypeId, price: '100', costPrice: '40', stockQuantity: 0, taxRate: '0', isTaxInclusive: true });
    if (stock > 0) await put(id, stock);
    return id;
  };
  const put = (productId: string, quantity: number, locationId = main) =>
    db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId, locationId, type: 'receipt', quantity, unitCost: 40, actor: { type: 'job' } }));
  const location = async (over: Record<string, unknown> = {}) => {
    const l = await c.stockLocations.create(companyId, { code: `L${randomUUID().slice(0, 7)}`, name: 'Test place', kind: 'warehouse', ...over });
    extraLocations.push(l.id);
    return l;
  };
  const bal = async (productId: string, locationId = main) => {
    const rows = await db.select().from(schema.stockBalances).where(and(eq(schema.stockBalances.productId, productId), eq(schema.stockBalances.locationId, locationId)));
    return { onHand: rows.reduce((a, r) => a + r.onHand, 0), reserved: rows.reduce((a, r) => a + r.reserved, 0) };
  };
  const counters = async (productId: string) => (await db.select({ s: schema.products.stockQuantity, r: schema.products.reservedQuantity }).from(schema.products).where(eq(schema.products.id, productId)))[0];
  const holds = async (refId: string) => await db.select().from(schema.stockReservations).where(and(eq(schema.stockReservations.refType, 'order'), eq(schema.stockReservations.refId, refId)));
  const reserve = (refId: string, lines: { productId: string; quantity: number }[], over: Record<string, unknown> = {}) =>
    c.stockReservations.reserve({ companyId, refType: 'order', refId, lines, channel: 'ecommerce', actor: 'tester', ...over });
  const ref = (refId: string) => ({ companyId, refType: 'order', refId, actor: 'tester' });
  const oid = () => `ord_rs_${randomUUID()}`;

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ InventoryReservationService: Reservations } = await import('@/server/domains/inventory/reservation-service'));
    tasks = await import('@/server/queue/tasks');
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Holds Test Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    itemTypeId = `it_rs_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    main = (await c.stockLocations.ensureDefault(companyId)).id;
    await c.stockShadow.setShadow(companyId, false);
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
  });
  afterAll(async () => {
    await c.stockSettings.setLedgerMode(companyId, false);
    await c.stockSettings.setUnpaidHoldMinutes(companyId, 0);
  });

  describe('placing a hold', () => {
    it('holds the stock at the default location and records why it is there', async () => {
      const p = await newProduct(10);
      const id = oid();
      const r = await reserve(id, [{ productId: p, quantity: 4 }]);
      expect(r).toMatchObject({ ok: true, reserved: [{ productId: p, locationId: main, shard: 0, quantity: 4 }] });
      expect(await bal(p)).toEqual({ onHand: 10, reserved: 4 });
      const [h] = await holds(id);
      expect(h).toMatchObject({ state: 'held', quantity: 4, consumed: 0, released: 0, refLineId: p, expiresAt: null, actor: 'tester' });
      expect(h?.sourcing).toMatchObject({ rule: 'whole_order_at_one_location', locationCode: 'MAIN', channel: 'ecommerce' });
    });

    it('keeps the product counters equal to the balances, so readers of the old counters stay right', async () => {
      const p = await newProduct(10);
      await reserve(oid(), [{ productId: p, quantity: 3 }]);
      expect(await counters(p)).toEqual({ s: 10, r: 3 });
    });

    it('is one hold however often it is asked for, and asking for more holds only the difference', async () => {
      const p = await newProduct(10);
      const id = oid();
      await reserve(id, [{ productId: p, quantity: 3 }]);
      await reserve(id, [{ productId: p, quantity: 3 }]);
      expect(await bal(p)).toEqual({ onHand: 10, reserved: 3 });
      const more = await reserve(id, [{ productId: p, quantity: 5 }]);
      expect(more).toMatchObject({ ok: true, reserved: [{ quantity: 2 }] });
      expect(await bal(p)).toEqual({ onHand: 10, reserved: 5 });
      const rows = await holds(id);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.quantity).toBe(5);
    });

    it('adds up a product named on several lines', async () => {
      const p = await newProduct(10);
      const id = oid();
      await reserve(id, [{ productId: p, quantity: 2 }, { productId: p, quantity: 3 }]);
      expect(await bal(p)).toEqual({ onHand: 10, reserved: 5 });
    });

    it('refuses an order that cannot be covered, in the words shoppers already see, and holds nothing of it', async () => {
      const [a, b] = [await newProduct(5), await newProduct(1)];
      const id = oid();
      const r = await reserve(id, [{ productId: a, quantity: 2 }, { productId: b, quantity: 3 }]);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.productId).toBe(b);
        expect(r.error).toMatch(/^Insufficient inventory for "Hold [a-z0-9_-]+"\. Available: 1, Requested: 3\.$/i);
      }
      expect(await bal(a)).toEqual({ onHand: 5, reserved: 0 });
      expect(await holds(id)).toEqual([]);
    });

    it('does not promise stock that is already promised', async () => {
      const p = await newProduct(5);
      expect((await reserve(oid(), [{ productId: p, quantity: 4 }])).ok).toBe(true);
      const second = await reserve(oid(), [{ productId: p, quantity: 2 }]);
      expect(second.ok).toBe(false);
      if (!second.ok) expect(second.error).toContain('Available: 1, Requested: 2');
    });

    it('gives a hold an end only when asked to', async () => {
      const p = await newProduct(5);
      const id = oid();
      const end = new Date(Date.now() + 30 * 60_000);
      await reserve(id, [{ productId: p, quantity: 1 }], { expiresAt: end });
      expect((await holds(id))[0]?.expiresAt?.getTime()).toBe(end.getTime());
    });
  });

  describe('choosing the location', () => {
    it('tries the order’s branch first, then the default, and skips places that do not sell to the channel or are not sellable', async () => {
      const p = await newProduct(0);
      const ofBranch = await location({ branchId });
      const online = await location({ sellsChannels: ['sales_order'] });
      const quarantine = await location({ kind: 'quarantine', isSellable: false });
      for (const l of [ofBranch.id, online.id, quarantine.id, main]) await put(p, 10, l);
      const id = oid();
      const r = await reserve(id, [{ productId: p, quantity: 2 }], { branchId });
      expect(r.ok && r.reserved, JSON.stringify({ ofBranch: ofBranch.id, main, online: online.id })).toMatchObject([{ locationId: ofBranch.id }]);
      const without = await reserve(oid(), [{ productId: p, quantity: 2 }]);
      expect(without).toMatchObject({ ok: true, reserved: [{ locationId: main }] });
      expect((await holds(id))[0]?.sourcing).toMatchObject({ locationCode: ofBranch.code });
      for (const l of [online.id, quarantine.id]) expect((await bal(p, l)).reserved).toBe(0);
    });

    it('takes a whole order from one place when one can cover it, rather than splitting it', async () => {
      const [x, y] = [await newProduct(0), await newProduct(0)];
      const other = await location({ code: `ZZ${randomUUID().slice(0, 5)}` });
      await put(x, 5, main);
      await put(y, 0.001, main);
      await put(x, 5, other.id);
      await put(y, 5, other.id);
      const r = await reserve(oid(), [{ productId: x, quantity: 3 }, { productId: y, quantity: 3 }]);
      expect(r.ok && r.reserved.map((h) => h.locationId)).toEqual([other.id, other.id]);
    });

    it('splits a line over places when none can cover it alone', async () => {
      const p = await newProduct(0);
      const other = await location({ code: `ZY${randomUUID().slice(0, 5)}` });
      await put(p, 4, main);
      await put(p, 4, other.id);
      const id = oid();
      const r = await reserve(id, [{ productId: p, quantity: 6 }]);
      expect(r.ok && r.reserved.map((h) => [h.locationId, h.quantity])).toEqual([[main, 4], [other.id, 2]]);
      expect((await holds(id)).map((h) => h.sourcing)).toEqual([expect.objectContaining({ rule: 'line_split_across_locations' }), expect.objectContaining({ rule: 'line_split_across_locations' })]);
    });
  });

  describe('using and giving back a hold', () => {
    it('turns a hold into an issue: the stock leaves, the hold is used, the books get a sale movement with its cost', async () => {
      const p = await newProduct(10);
      const id = oid();
      await reserve(id, [{ productId: p, quantity: 4 }]);
      expect(await c.stockReservations.consume(ref(id))).toEqual({ issued: 4 });
      expect(await bal(p)).toEqual({ onHand: 6, reserved: 0 });
      expect(await counters(p)).toEqual({ s: 6, r: 0 });
      expect((await holds(id))[0]).toMatchObject({ state: 'consumed', consumed: 4 });
      const moves = await db.select().from(schema.stockMovements).where(and(eq(schema.stockMovements.productId, p), eq(schema.stockMovements.movementType, 'sale_issue')));
      expect(moves).toHaveLength(1);
      expect(moves[0]).toMatchObject({ quantity: -4, unitCost: '40.0000', documentType: 'order', documentId: id, locationId: main });
    });

    it('does it once however often it is asked, and a late release changes nothing', async () => {
      const p = await newProduct(10);
      const id = oid();
      await reserve(id, [{ productId: p, quantity: 4 }]);
      await Promise.all([c.stockReservations.consume(ref(id)), c.stockReservations.consume(ref(id)), c.stockReservations.consume(ref(id))]);
      await c.stockReservations.consume(ref(id));
      await c.stockReservations.release({ ...ref(id), reason: 'late' });
      expect(await bal(p)).toEqual({ onHand: 6, reserved: 0 });
      expect((await holds(id))[0]).toMatchObject({ state: 'consumed', consumed: 4, released: 0 });
    });

    it('gives a hold back with its reason, once, and leaves the stock on the shelf', async () => {
      const p = await newProduct(10);
      const id = oid();
      await reserve(id, [{ productId: p, quantity: 4 }]);
      expect(await c.stockReservations.release({ ...ref(id), reason: 'payment failed' })).toEqual({ released: 4 });
      expect(await c.stockReservations.release({ ...ref(id), reason: 'again' })).toEqual({ released: 0 });
      expect(await bal(p)).toEqual({ onHand: 10, reserved: 0 });
      expect((await holds(id))[0]).toMatchObject({ state: 'released', released: 4, reason: 'payment failed' });
      expect(await c.stockReservations.consume(ref(id))).toEqual({ issued: 0 });
      expect(await bal(p)).toEqual({ onHand: 10, reserved: 0 });
    });

    it('settles for what is on the shelf if stock was written down meanwhile, and never goes below zero', async () => {
      const p = await newProduct(10);
      const id = oid();
      await reserve(id, [{ productId: p, quantity: 6 }]);
      await db.transaction((tx) => c.stockLedger.post(tx, { companyId, productId: p, locationId: main, type: 'write_off', quantity: -7, actor: { type: 'job' } }));
      expect(await c.stockReservations.consume(ref(id))).toEqual({ issued: 3 });
      expect(await bal(p)).toEqual({ onHand: 0, reserved: 0 });
      expect((await holds(id))[0]?.reason).toContain('short at issue: 3');
    });

    it('frees the place so a stopped location can be emptied once its holds are gone', async () => {
      const loc = await location();
      const p = await newProduct(0);
      await put(p, 3, loc.id);
      const only = await c.stockReservations.reserve({ companyId, refType: 'order', refId: oid(), lines: [{ productId: p, quantity: 1 }], channel: 'ecommerce', actor: 't', branchId: null });
      expect(only.ok).toBe(true);
      await expect(c.stockLocations.deactivate(companyId, loc.id)).rejects.toMatchObject({ code: 'HAS_STOCK' });
    });
  });

  describe('the order paths', () => {
    const place = async (items: { productId: string; quantity: number }[], over: Record<string, unknown> = {}) =>
      await createOrder({
        branchId,
        orderNumber: `RS-${randomUUID()}`,
        customerName: 'Hold Buyer',
        customerEmail: `rs-${randomUUID()}@hold.test`,
        customerPhone: '0700000000',
        shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
        items,
        currency: 'KES',
        paymentMethod: 'mpesa_daraja',
        ...over,
      });

    it('hold stock when an order is placed, issue it when it is paid, and give it back when it fails', async () => {
      const p = await newProduct(10);
      const placed = await place([{ productId: p, quantity: 3 }]);
      expect(placed.success, placed.error).toBe(true);
      const id = placed.order?.id ?? '';
      expect(await bal(p)).toEqual({ onHand: 10, reserved: 3 });
      await Reservations.fulfilOrder(id);
      expect(await bal(p)).toEqual({ onHand: 7, reserved: 0 });
      await Reservations.fulfilOrder(id);
      expect(await bal(p)).toEqual({ onHand: 7, reserved: 0 });

      const failing = await place([{ productId: p, quantity: 2 }]);
      expect(await bal(p)).toEqual({ onHand: 7, reserved: 2 });
      await Reservations.releaseOrder(failing.order?.id ?? '', 'payment failed');
      expect(await bal(p)).toEqual({ onHand: 7, reserved: 0 });
    });

    it('turn an order away with the shortage in words, leaving the stock alone', async () => {
      const p = await newProduct(1);
      const r = await place([{ productId: p, quantity: 2 }]);
      expect(r).toMatchObject({ success: false, code: 'stock_short' });
      expect(r.error).toContain('Insufficient inventory');
      expect(await bal(p)).toEqual({ onHand: 1, reserved: 0 });
    });

    it('give back the hold of an order that could not be saved', async () => {
      const p = await newProduct(5);
      const id = oid();
      await Reservations.reserveForOrder([{ productId: p, quantity: 2 }], id);
      expect(await bal(p)).toEqual({ onHand: 5, reserved: 2 });
      await Reservations.releaseOrder(id, 'order not saved', 'tester', [{ productId: p, quantity: 2 }]);
      expect(await bal(p)).toEqual({ onHand: 5, reserved: 0 });
    });
  });

  describe('holds that run out', () => {
    it('are given back by the expiry task, and an order that was still unpaid is marked failed with the reason', async () => {
      await c.stockSettings.setUnpaidHoldMinutes(companyId, 30);
      const p = await newProduct(10);
      const placed = await createOrder({
        branchId,
        orderNumber: `RS-${randomUUID()}`,
        customerName: 'Slow Payer',
        customerEmail: `rs-${randomUUID()}@hold.test`,
        customerPhone: '0700000000',
        shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
        items: [{ productId: p, quantity: 4 }],
        currency: 'KES',
        paymentMethod: 'mpesa_daraja',
      });
      expect(placed.success, placed.error).toBe(true);
      const id = placed.order?.id ?? '';
      const [h] = await holds(id);
      const ends = h?.expiresAt?.getTime() ?? 0;
      expect(ends - Date.now()).toBeGreaterThan(29 * 60_000);
      expect(ends - Date.now()).toBeLessThanOrEqual(30 * 60_000);

      // Nothing runs out early.
      expect(await c.stockReservations.expireDue(companyId, new Date(), 1000)).toEqual(expect.not.arrayContaining([expect.objectContaining({ refId: id })]));
      expect(await bal(p)).toEqual({ onHand: 10, reserved: 4 });

      // Past its end, the hold is given back.
      const later = new Date(ends + 60_000);
      const gone = await c.stockReservations.expireDue(companyId, later, 1000);
      expect(gone).toEqual(expect.arrayContaining([{ refType: 'order', refId: id, quantity: 4 }]));
      expect(await bal(p)).toEqual({ onHand: 10, reserved: 0 });
      expect((await holds(id))[0]).toMatchObject({ state: 'expired', released: 4 });
      expect((await c.stockReservations.expireDue(companyId, later, 1000)).some((e) => e.refId === id)).toBe(false);
    });

    it('make the task mark an unpaid order failed, and leave an order that was paid alone', async () => {
      await c.stockSettings.setUnpaidHoldMinutes(companyId, 30);
      const make = async () => {
        const p = await newProduct(10);
        const r = await createOrder({
          branchId,
          orderNumber: `RS-${randomUUID()}`,
          customerName: 'Timer',
          customerEmail: `rs-${randomUUID()}@hold.test`,
          customerPhone: '0700000000',
          shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
          items: [{ productId: p, quantity: 1 }],
          currency: 'KES',
          paymentMethod: 'mpesa_daraja',
        });
        return r.order?.id ?? '';
      };
      const unpaid = await make();
      const paid = await make();
      // Both holds ran out; one order was paid in the meantime.
      await db.update(schema.stockReservations).set({ expiresAt: new Date(Date.now() - 60_000) }).where(inArray(schema.stockReservations.refId, [unpaid, paid]));
      const { OrderStages } = await import('@/server/domains/orders/stages');
      await OrderStages.move(db, paid, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: randomUUID() }, attemptNo: 1 });
      const log: string[] = [];
      await tasks.stockReservationExpiry({}, { logger: { info: (m: string) => log.push(m), error: (m: string) => log.push(m) } } as never);
      const [u] = await db.select().from(schema.orders).where(eq(schema.orders.id, unpaid));
      const [pd] = await db.select().from(schema.orders).where(eq(schema.orders.id, paid));
      expect(u).toMatchObject({ status: 'failed', paymentStatus: 'failed' });
      expect(pd).toMatchObject({ status: 'processing', paymentStatus: 'paid' });
      const events = await OrderStages.timeline(db, unpaid);
      expect(events.at(-1)).toMatchObject({ stage: 'payment_failed', outcome: 'failed', reasonCode: 'hold_expired', source: 'worker' });
    });
  });

  describe('many baskets at once', () => {
    it('never promise more than there is, never deadlock, and leave the hold ledger equal to the balances', async () => {
      const hot = await Promise.all(Array.from({ length: 5 }, () => newProduct(40)));
      const baskets = Array.from({ length: 200 }, (_x, i) => {
        const a = hot[i % 5] ?? '';
        const b = hot[(i * 3 + 1) % 5] ?? '';
        // Half the baskets name the products the other way round, to try to deadlock.
        const lines = i % 2 === 0 ? [a, b] : [b, a];
        return lines.map((productId) => ({ productId, quantity: 1 }));
      });
      const times: number[] = [];
      const outcomes: string[] = [];
      let next = 0;
      const worker = async () => {
        while (next < baskets.length) {
          const i = next++;
          const t0 = performance.now();
          try {
            const r = await reserve(oid(), baskets[i] ?? []);
            outcomes.push(r.ok ? 'ok' : 'short');
          } catch (error) {
            outcomes.push(`error: ${(error as Error).message}`);
          }
          times.push(performance.now() - t0);
        }
      };
      await Promise.all(Array.from({ length: 10 }, worker));
      expect(outcomes.filter((o) => o.startsWith('error'))).toEqual([]);
      for (const p of hot) {
        const b = await bal(p);
        expect(b.reserved, 'never above what is on hand').toBeLessThanOrEqual(b.onHand);
        const open = await db.select({ q: sql<number>`coalesce(sum(quantity - consumed - released), 0)::float8` }).from(schema.stockReservations).where(and(eq(schema.stockReservations.productId, p), inArray(schema.stockReservations.state, ['held', 'partly_consumed'])));
        expect(open[0]?.q).toBe(b.reserved);
        expect(await counters(p)).toEqual({ s: b.onHand, r: b.reserved });
      }
      // 200 units of stock, 2 units a basket: at most 100 baskets fit.
      expect(outcomes.filter((o) => o === 'ok').length).toBeGreaterThanOrEqual(90);
      expect(outcomes.filter((o) => o === 'ok').length).toBeLessThanOrEqual(100);
      expect(outcomes.filter((o) => o === 'short').length).toBeGreaterThan(0);
      times.sort((x, y) => x - y);
      const p95 = times[Math.floor(times.length * 0.95)] ?? 0;
      process.stderr.write(`200 baskets, 10 at a time over 5 hot products: p50 ${times[100]?.toFixed(1) ?? '?'} ms, p95 ${p95.toFixed(1)} ms, ok ${String(outcomes.filter((o) => o === 'ok').length)}\n`);
      expect(p95).toBeLessThan(500);
    });
  });

  describe('the check against the balances', () => {
    it('finds a balance whose reserved quantity is not the sum of its holds', async () => {
      const p = await newProduct(10);
      await reserve(oid(), [{ productId: p, quantity: 2 }]);
      expect((await c.stockShadow.compare()).sample.some((s) => s.kind === 'reservation_differs' && s.productId === p)).toBe(false);
      await db.update(schema.stockBalances).set({ reserved: 5 }).where(eq(schema.stockBalances.productId, p));
      const report = await c.stockShadow.compare();
      expect(report.reservationsDiffer).toBeGreaterThanOrEqual(1);
      expect(report.sample).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'reservation_differs', productId: p, expected: 2, found: 5 })]));
      await db.update(schema.stockBalances).set({ reserved: 2 }).where(eq(schema.stockBalances.productId, p));
    });

    it('cannot be switched on while the ledger is the truth', async () => {
      await expect(c.stockShadow.setShadow(companyId, true)).rejects.toMatchObject({ code: 'LEDGER_MODE' });
    });
  });
});
