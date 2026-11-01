import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { has } from '@/lib/values';
import { customerTimeline, isOrderStage } from '@/lib/order-stages';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as InventoryModule from '@/server/domains/inventory/service';
import type * as ReservationModule from '@/server/domains/inventory/reservation-service';
import type * as StagesModule from '@/server/domains/orders/stages';
import type * as TasksModule from '@/server/queue/tasks';
import type * as ReadModule from '@/server/domains/orders/timeline-read';
import type { OrderWriteService as OrderWriteServiceType } from '@/server/domains/orders/write-service';
import { settleFinanceBacklog } from './test-support';

/**
 * What happens to an order's stock is on the order's own timeline with its time and reason, in both ways of keeping stock; and it sits
 * beside the order's journey without becoming where the order is.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('the stock stages of an order (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let inv: typeof InventoryModule;
  let Reservations: typeof ReservationModule.InventoryReservationService;
  let Stages: typeof StagesModule.OrderStages;
  let tasks: typeof TasksModule;
  let read: typeof ReadModule;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let companyId: string;
  let branchId: string;
  let itemTypeId: string;
  const made: string[] = [];

  const product = async (stock: number) => {
    const id = `prod_ss_${randomUUID()}`;
    made.push(id);
    await db.insert(schema.products).values({ id, sku: `SS-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `SSS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: `Staged ${id.slice(-6)}`, slug: `ss-${randomUUID()}`, itemTypeId, price: '20', costPrice: '10', stockQuantity: 0 });
    if (stock > 0) await db.transaction((tx) => inv.applyStockDelta(tx, { productId: id, delta: stock, changeType: 'purchase_order_receipt', referenceId: `GRN-${randomUUID().slice(0, 6)}`, actor: 'tester', note: 'seed' }));
    return id;
  };
  const place = async (productId: string, quantity: number) => {
    const r = await createOrder({
      branchId,
      orderNumber: `SS-${randomUUID()}`,
      customerName: 'Stage Buyer',
      customerEmail: `ss-${randomUUID()}@stage.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
    });
    expect(r.success, r.error).toBe(true);
    return r.order?.id ?? '';
  };
  const events = async (orderId: string) => await Stages.timeline(db, orderId);
  const stockEvents = async (orderId: string) => (await events(orderId)).filter((e) => e.stage.startsWith('stock_'));
  const order = async (orderId: string) => (await db.select().from(schema.orders).where(eq(schema.orders.id, orderId)))[0];
  const pay = (orderId: string) => Stages.move(db, orderId, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: randomUUID() }, attemptNo: 1 });

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    inv = await import('@/server/domains/inventory/service');
    ({ InventoryReservationService: Reservations } = await import('@/server/domains/inventory/reservation-service'));
    ({ OrderStages: Stages } = await import('@/server/domains/orders/stages'));
    tasks = await import('@/server/queue/tasks');
    read = await import('@/server/domains/orders/timeline-read');
    const writer = (await import('@/server/domains/orders/write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Stage Test Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    itemTypeId = `it_ss_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    await c.stockLocations.ensureDefault(companyId);
    await c.stockShadow.setShadow(companyId, false);
  });
  afterAll(async () => {
    await c.stockSettings.setLedgerMode(companyId, false);
    await c.stockSettings.setUnpaidHoldMinutes(companyId, 0);
    if (made.length > 0) {
      const { inArray } = await import('drizzle-orm');
      await db.delete(schema.products).where(inArray(schema.products.id, made));
    }
    await settleFinanceBacklog(c.finance);
  }, 120_000);

  describe.each([
    ['the new ledger', true],
    ['the old counters', false],
  ])('keeping stock in %s', (_name, ledger) => {
    const kept = ledger ? 'ledger' : 'counters';
    const setMode = async () => {
      if (ledger) await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
      else await c.stockSettings.setLedgerMode(companyId, false);
    };

    it('says the stock was set aside when the order is placed, with where, and does not move the order’s stage', async () => {
      await setMode();
      const p = await product(10);
      const id = await place(p, 3);
      const all = await events(id);
      expect(all.map((e) => e.stage)).toEqual(['order_placed', 'stock_reserved']);
      const [reserved] = await stockEvents(id);
      expect(reserved).toMatchObject({ stage: 'stock_reserved', outcome: 'succeeded', refType: 'stock_hold', refId: id, sequence: 2, approximate: false });
      expect(reserved?.detail).toMatchObject({ kept, products: 1 });
      if (ledger) expect(reserved?.detail).toMatchObject({ places: [{ code: 'MAIN', quantity: 3 }] });
      expect(reserved?.occurredAt).toBeInstanceOf(Date);
      expect(await order(id)).toMatchObject({ currentStage: 'order_placed', stageSeq: 2 });
    });

    it('says the stock was issued when the order is paid, once, and the order stays where its payment put it', async () => {
      await setMode();
      const p = await product(10);
      const id = await place(p, 2);
      await pay(id);
      const before = await order(id);
      expect(before).toMatchObject({ currentStage: 'payment_confirmed' });
      await Reservations.fulfilOrder(id);
      await Reservations.fulfilOrder(id);
      const issued = (await stockEvents(id)).filter((e) => e.stage === 'stock_issued');
      expect(issued).toHaveLength(1);
      expect(issued[0]).toMatchObject({ outcome: 'succeeded', refType: 'stock_settlement', refId: id });
      expect(issued[0]?.detail).toMatchObject({ kept });
      const after = await order(id);
      expect(after).toMatchObject({ currentStage: 'payment_confirmed', status: 'processing', paymentStatus: 'paid' });
      expect(after?.currentStageSince?.getTime()).toBe(before?.currentStageSince?.getTime());
      const seqs = (await events(id)).map((e) => e.sequence);
      expect(seqs).toEqual(seqs.map((_x, i) => i + 1));
    });

    it('says the stock was given back, why, and once, when an order is cancelled or its payment fails', async () => {
      await setMode();
      const [a, b, d] = [await product(5), await product(5), await product(5)];
      const cancelled = await place(a, 1);
      const failed = await place(b, 1);
      const other = await place(d, 1);
      await Reservations.releaseOrder(cancelled, 'order cancelled: the customer changed their mind', 'admin');
      await Reservations.releaseOrder(cancelled, 'order cancelled: again', 'admin');
      await Reservations.releaseOrder(failed, 'payment_callback_failed', 'payment:mpesa_daraja');
      await Reservations.releaseOrder(other, 'something else entirely');
      const one = (await stockEvents(cancelled)).filter((e) => e.stage === 'stock_released');
      expect(one).toHaveLength(1);
      expect(one[0]).toMatchObject({ outcome: 'succeeded', reasonCode: 'cancelled', message: 'order cancelled: the customer changed their mind' });
      expect((await stockEvents(failed)).find((e) => e.stage === 'stock_released')).toMatchObject({ reasonCode: 'payment_failed' });
      expect((await stockEvents(other)).find((e) => e.stage === 'stock_released')).toMatchObject({ reasonCode: 'released' });
    });

    it('gives an order that was already paid nothing to say about being given back', async () => {
      await setMode();
      const p = await product(5);
      const id = await place(p, 1);
      await pay(id);
      await Reservations.fulfilOrder(id);
      await Reservations.releaseOrder(id, 'order cancelled: too late', 'admin');
      expect((await stockEvents(id)).map((e) => e.stage)).toEqual(['stock_reserved', 'stock_issued']);
    });

    it('records nothing for an order that was never saved: it has no timeline', async () => {
      await setMode();
      const p = await product(5);
      const ghost = `ord_ghost_${randomUUID()}`;
      expect((await Reservations.reserveForOrder([{ productId: p, quantity: 2 }], ghost)).success).toBe(true);
      await Reservations.releaseOrder(ghost, 'order creation failed', 'system', [{ productId: p, quantity: 2 }]);
      expect(await db.select().from(schema.orderStageEvents).where(eq(schema.orderStageEvents.orderId, ghost))).toEqual([]);
    });

    it('is on the staff timeline in plain words with its time, never on the customer’s, and never in the way of the late-order check', async () => {
      await setMode();
      const p = await product(5);
      const id = await place(p, 1);
      await pay(id);
      await Reservations.fulfilOrder(id);
      const view = await read.orderTimeline(db, id, true);
      const labels = (view?.events ?? []).map((e) => e.label);
      expect(labels).toEqual(expect.arrayContaining(['Stock reserved', 'Stock issued']));
      expect(view?.currentStage).toBe('payment_confirmed');
      const stages = (await events(id)).filter((e) => isOrderStage(e.stage)).map((e) => ({ stage: e.stage, outcome: e.outcome, occurredAt: e.occurredAt }));
      const shown = customerTimeline(stages).map((s) => s.label);
      expect(shown.join(' ')).not.toMatch(/stock/i);
      // The order still counts as waiting after payment, so the check for orders that wait too long still sees it.
      expect((await order(id))?.currentStage).toBe('payment_confirmed');
    });
  });

  it('says in the ledger an expired hold was given back for running out, then that the payment failed, in that order', async () => {
    await c.stockSettings.setLedgerMode(companyId, true, { requireCleanShadow: false });
    await c.stockSettings.setUnpaidHoldMinutes(companyId, 30);
    try {
      const p = await product(5);
      const id = await place(p, 2);
      await db.update(schema.stockReservations).set({ expiresAt: new Date(Date.now() - 60_000) }).where(eq(schema.stockReservations.refId, id));
      await tasks.stockReservationExpiry({}, { logger: { info: () => undefined, error: () => undefined } } as never);
      const all = await events(id);
      expect(all.map((e) => [e.stage, e.outcome])).toEqual([['order_placed', 'succeeded'], ['stock_reserved', 'succeeded'], ['stock_released', 'succeeded'], ['payment_failed', 'failed']]);
      expect(all[2]).toMatchObject({ reasonCode: 'hold_expired', source: 'worker' });
      expect(all[3]).toMatchObject({ reasonCode: 'hold_expired' });
      expect(await order(id)).toMatchObject({ currentStage: 'payment_failed', status: 'failed' });
    } finally {
      await c.stockSettings.setUnpaidHoldMinutes(companyId, 0);
    }
  });
});
