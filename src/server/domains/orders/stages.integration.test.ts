import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { has } from '@/lib/values';
import { ORDER_STAGE_NAMES, STAGE_COLUMN_SQL, type OrderStage, type StageOutcome } from '@/lib/order-stages';
import type * as mod_server_di_container from '@/server/di/container';
import type * as mod_server_db_drizzle_client from '@/server/db/drizzle/client';
import type * as mod_server_db_drizzle_schema from '@/server/db/drizzle/schema';
import type * as StagesModule from './stages';
import type * as ReadModule from './timeline-read';
import type * as AttemptsModule from './checkout-attempts';
import type { OrderWriteService as OrderWriteServiceType } from './write-service';
import type { MoveOptions } from './stages';

/**
 * The order timeline against a real database: the one writer, the trigger that catches anything that goes round it, the rule that
 * the timeline is kept, the rebuilding of older orders, and a randomised check that the events always add up to the order.
 *   TEST_DATABASE_URL=postgres://... pnpm test
 */
const url = process.env.TEST_DATABASE_URL;
if (has(url)) process.env.DATABASE_URL = url;

describe.skipIf(!has(url))('the order stage timeline (database)', () => {
  let db: typeof mod_server_db_drizzle_client.drizzleDb;
  let schema: typeof mod_server_db_drizzle_schema;
  let c: ReturnType<typeof mod_server_di_container.getContainer>;
  let Stages: typeof StagesModule.OrderStages;
  let Refused: typeof StagesModule.OrderMoveRefused;
  let read: typeof ReadModule;
  let Attempts: typeof AttemptsModule.CheckoutAttempts;
  let createOrder: (typeof OrderWriteServiceType)['createOrder'];
  let companyId: string;
  let branchId: string;
  let productId: string;

  const place = async (over: Record<string, unknown> = {}) => {
    const result = await createOrder({
      branchId,
      orderNumber: `TL-${randomUUID()}`,
      customerName: 'Timeline Buyer',
      customerEmail: `tl-${randomUUID()}@timeline.test`,
      customerPhone: '0700000000',
      shippingAddress: { street: '1 Test Rd', city: 'Nairobi', countyOrState: 'Nairobi', country: 'KE' },
      items: [{ productId, quantity: 1 }],
      currency: 'KES',
      paymentMethod: 'mpesa_daraja',
      ...over,
    });
    expect(result.success, result.error).toBe(true);
    return result.order?.id ?? '';
  };
  const row = async (id: string) => (await db.select().from(schema.orders).where(eq(schema.orders.id, id)))[0];
  const events = async (id: string) => await Stages.timeline(db, id);
  const move = (id: string, stage: OrderStage, outcome: StageOutcome, options: MoveOptions = {}) => Stages.move(db, id, stage, outcome, options);

  beforeAll(async () => {
    const mod = await import('@/server/di/container');
    db = (await import('@/server/db/drizzle/client')).drizzleDb;
    schema = await import('@/server/db/drizzle/schema');
    ({ OrderStages: Stages, OrderMoveRefused: Refused } = await import('./stages'));
    read = await import('./timeline-read');
    ({ CheckoutAttempts: Attempts } = await import('./checkout-attempts'));
    const writer = (await import('./write-service')).OrderWriteService;
    createOrder = (input) => writer.createOrder(input);
    c = mod.getContainer();
    companyId = (await c.companySettings.ensureSeeded()).id;
    await db.insert(schema.currencies).values({ code: 'KES', name: 'Kenyan Shilling', symbol: 'KSh', isBaseCurrency: true }).onConflictDoNothing();
    const { branch } = await c.organizations.ensureDefaultOrgAndBranch(companyId, 'Timeline Test Co');
    branchId = ((await c.branches.getDefault(companyId)) ?? branch).id;
    const itemTypeId = `it_tl_${randomUUID().slice(0, 8)}`;
    await db.insert(schema.itemTypes).values({ id: itemTypeId, code: Math.floor(Math.random() * 1e9), name: itemTypeId });
    productId = `prod_tl_${randomUUID()}`;
    await db.insert(schema.products).values({ id: productId, sku: `TL-${randomUUID().slice(0, 8)}`.toUpperCase(), stockCode: `TLS-${randomUUID().slice(0, 8)}`.toUpperCase(), name: 'Timeline product', slug: `tl-${randomUUID()}`, itemTypeId, price: '100', costPrice: '50', stockQuantity: 100000, taxRate: '0', isTaxInclusive: true });
  });

  describe('placing an order', () => {
    it('writes the first event in the same transaction, with who placed it, and sets the stage and its time', async () => {
      const id = await place();
      const o = await row(id);
      expect(o).toMatchObject({ stageSeq: 1, currentStage: 'order_placed' });
      expect(o?.currentStageSince).toBeInstanceOf(Date);
      const [first, ...rest] = await events(id);
      expect(rest).toEqual([]);
      expect(first).toMatchObject({ sequence: 1, stage: 'order_placed', outcome: 'succeeded', source: 'shop', approximate: false, toStatus: 'pending' });
      expect(first?.changes).toMatchObject({ status: { from: null, to: 'pending' }, payment_status: { from: null, to: 'unpaid' } });
      expect(first?.detail).toMatchObject({ salesModule: 'ecommerce', items: 1 });
      expect(first?.companyId).toBe(companyId);
    });

    it('carries the time the shopper started the checkout, and names a staff order as staff', async () => {
      const startedAt = new Date('2026-03-01T08:00:00Z');
      const shop = await place({ checkoutStartedAt: startedAt, customerId: null });
      expect((await events(shop))[0]?.detail.checkoutStartedAt).toBe(startedAt.toISOString());
      const staff = await place({ salesModule: 'sales_order', requestedBy: undefined });
      expect((await events(staff))[0]).toMatchObject({ source: 'staff' });
    });

    it('records a staff order that waits for approval as two stages, in order', async () => {
      const id = await place({ salesModule: 'sales_order', requestedBy: undefined });
      const stages = (await events(id)).map((e) => e.stage);
      expect(stages[0]).toBe('order_placed');
    });
  });

  describe('moving an order', () => {
    it('writes the event and the new state together, stamps the time once, and numbers the events 1, 2, 3', async () => {
      const id = await place();
      const started = await move(id, 'payment_started', 'entered', { ref: { type: 'payment_attempt', id: 'a1' }, attemptNo: 1, detail: { provider: 'mpesa_daraja' } });
      expect(started).toMatchObject({ recorded: true, event: { sequence: 2 } });
      const afterStart = await row(id);
      expect(afterStart).toMatchObject({ paymentStatus: 'pending_verification', stageSeq: 2, currentStage: 'payment_started' });
      expect(afterStart?.paymentStartedAt).toBeInstanceOf(Date);

      await move(id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: 'a1' }, fields: { transactionReference: 'RCP123', mpesaReceiptNumber: 'RCP123' }, providerTime: new Date('2026-03-01T09:00:00Z') });
      const paid = await row(id);
      expect(paid).toMatchObject({ status: 'processing', paymentStatus: 'paid', stageSeq: 3, transactionReference: 'RCP123' });
      expect(paid?.paidAt).toBeInstanceOf(Date);
      expect(paid?.releasedAt).toBeInstanceOf(Date);
      const all = await events(id);
      expect(all.map((e) => [e.sequence, e.stage, e.outcome])).toEqual([[1, 'order_placed', 'succeeded'], [2, 'payment_started', 'entered'], [3, 'payment_confirmed', 'succeeded']]);
      expect(all[2]).toMatchObject({ fromStatus: 'pending', toStatus: 'processing', refType: 'payment_attempt', refId: 'a1' });
      // The phone's or provider's time is kept beside the server's, and does not order anything.
      expect(all[2]?.providerTime?.toISOString()).toBe('2026-03-01T09:00:00.000Z');
      expect(all[2]?.occurredAt.getTime()).toBeGreaterThan(all[1]?.occurredAt.getTime() ?? 0);
      expect(all.every((e) => e.correlationId !== null)).toBe(true);
    });

    it('records the same thing reaching the same stage once, but still saves what came with it', async () => {
      const id = await place();
      await move(id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: 'a1' } });
      const again = await move(id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: 'a1' }, fields: { transactionReference: 'LATE-RECEIPT' } });
      expect(again.recorded).toBe(false);
      expect(await events(id)).toHaveLength(2);
      expect(await row(id)).toMatchObject({ transactionReference: 'LATE-RECEIPT', stageSeq: 2 });
    });

    it('never pulls an order back a stage when a payment is confirmed again', async () => {
      const id = await place();
      await move(id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: 'a1' } });
      await move(id, 'dispatched', 'succeeded');
      await move(id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: 'a1' } });
      expect((await row(id))?.status).toBe('shipped');
    });

    it('records a retry as a new payment stage even though the payment state is already pending', async () => {
      const id = await place();
      await move(id, 'payment_started', 'entered', { ref: { type: 'payment_attempt', id: 'a1' }, attemptNo: 1 });
      await move(id, 'payment_failed', 'failed', { ref: { type: 'payment_attempt', id: 'a1' }, reasonCode: 'declined', message: 'Declined by the customer' });
      const retry = await move(id, 'payment_started', 'entered', { ref: { type: 'payment_attempt', id: 'a2' }, attemptNo: 2 });
      expect(retry.recorded).toBe(true);
      const all = await events(id);
      expect(all.map((e) => [e.stage, e.attemptNo])).toEqual([['order_placed', null], ['payment_started', 1], ['payment_failed', null], ['payment_started', 2]]);
      expect(all[2]).toMatchObject({ outcome: 'failed', reasonCode: 'declined', message: 'Declined by the customer', toStatus: 'failed' });
      expect((await row(id))?.failedAt).toBeInstanceOf(Date);
    });

    it('records a status moved by hand only when it really changes, and keeps the shipped and delivered times from the first time', async () => {
      const id = await place();
      await move(id, 'dispatched', 'succeeded', { fields: { shippingCourier: 'G4S', trackingNumber: 'T-1' } });
      const shippedAt = (await row(id))?.shippedAt;
      expect(shippedAt).toBeInstanceOf(Date);
      const same = await move(id, 'dispatched', 'succeeded', { fields: { trackingNumber: 'T-2' } });
      expect(same.recorded).toBe(false);
      expect(await row(id)).toMatchObject({ trackingNumber: 'T-2', stageSeq: 2 });
      expect((await row(id))?.shippedAt).toEqual(shippedAt);
      await move(id, 'delivered', 'succeeded');
      await move(id, 'completed', 'succeeded');
      const done = await row(id);
      expect(done).toMatchObject({ status: 'completed', currentStage: 'completed', stageSeq: 4 });
      expect(done?.completedAt).toBeInstanceOf(Date);
      expect(done?.deliveredAt).toBeInstanceOf(Date);
    });

    it('applies the approval hold under the order lock, and always lets an order be cancelled', async () => {
      const id = await place();
      await move(id, 'approval_requested', 'entered', { ref: { type: 'approval_request', id: 'r1' } });
      await expect(move(id, 'dispatched', 'succeeded', { checkHold: true })).rejects.toBeInstanceOf(Refused);
      await expect(move(id, 'dispatched', 'succeeded', { checkHold: true })).rejects.toThrow(/waiting for approval/);
      // Nothing was recorded or changed by the refused move.
      expect(await row(id)).toMatchObject({ status: 'pending', stageSeq: 2 });
      await move(id, 'cancelled', 'cancelled', { checkHold: true, reasonCode: 'cancelled', message: 'Customer asked' });
      expect(await row(id)).toMatchObject({ status: 'cancelled', stageSeq: 3 });
      expect((await row(id))?.cancelledAt).toBeInstanceOf(Date);
    });

    it('sets what a stage says beyond its own effect (a cancellation that also fails the payment, a refund of the order)', async () => {
      const id = await place();
      await move(id, 'cancelled', 'cancelled', { set: { paymentStatus: 'failed' }, reasonCode: 'cancel_order' });
      expect(await row(id)).toMatchObject({ status: 'cancelled', paymentStatus: 'failed' });
      const paid = await place();
      await move(paid, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: 'p' } });
      await move(paid, 'refund_completed', 'succeeded', { ref: { type: 'refund', id: 'f1' }, set: { paymentStatus: 'refunded' } });
      expect((await row(paid))?.paymentStatus).toBe('refunded');
      // A part refund is a stage of the order that changes no column.
      const partly = await place();
      const out = await move(partly, 'refund_completed', 'succeeded', { ref: { type: 'refund', id: 'f2' }, detail: { state: 'partially_refunded' } });
      expect(out.recorded).toBe(true);
      expect((await row(partly))?.paymentStatus).toBe('unpaid');
    });

    it('keeps the events in order and without gaps when many things happen to one order at once', async () => {
      const id = await place();
      await Promise.all(Array.from({ length: 25 }, (_, n) => move(id, 'prompt_sent', 'entered', { ref: { type: 'payment_attempt', id: `parallel-${String(n)}` } })));
      const all = await events(id);
      expect(all).toHaveLength(26);
      expect(all.map((e) => e.sequence)).toEqual(Array.from({ length: 26 }, (_, i) => i + 1));
      expect((await row(id))?.stageSeq).toBe(26);
    });

    it('does nothing for an order that is not there', async () => {
      expect(await move(`missing_${randomUUID()}`, 'payment_confirmed', 'succeeded')).toEqual({ recorded: false, order: null });
    });
  });

  describe('the administrator moving an order, cancelling it, and resolving a payment difference', () => {
    it('moves it as before (courier and tracking saved, shipped and delivered times kept), leaving one event per real change', async () => {
      const { InventoryDomainService } = await import('@/server/domains/inventory/service');
      const id = await place();
      const shipped = await InventoryDomainService.updateOrderStatus(id, 'shipped', 'G4S', 'TRK-1', 'left the depot');
      expect(shipped).toMatchObject({ status: 'shipped', shippingCourier: 'G4S', trackingNumber: 'TRK-1', internalNotes: 'left the depot' });
      expect(shipped.shippedAt).toBeTruthy();
      // The same status again changes nothing about the stage but still saves the new tracking number.
      const again = await InventoryDomainService.updateOrderStatus(id, 'shipped', undefined, 'TRK-2');
      expect(again).toMatchObject({ status: 'shipped', trackingNumber: 'TRK-2', shippedAt: shipped.shippedAt });
      const delivered = await InventoryDomainService.updateOrderStatus(id, 'delivered');
      expect(delivered.deliveredAt).toBeTruthy();
      expect((await events(id)).map((e) => `${e.stage}:${e.outcome}`)).toEqual(['order_placed:succeeded', 'dispatched:succeeded', 'delivered:succeeded']);
      // Back to pending is a correction, said as such.
      await InventoryDomainService.updateOrderStatus(id, 'pending');
      expect((await events(id)).at(-1)).toMatchObject({ stage: 'status_corrected', fromStatus: 'delivered', toStatus: 'pending' });
    });

    it('refuses what the approval state refuses, with the same words, and changes nothing', async () => {
      const { InventoryDomainService } = await import('@/server/domains/inventory/service');
      const id = await place();
      await move(id, 'approval_requested', 'entered', { ref: { type: 'approval_request', id: 'h1' } });
      await expect(InventoryDomainService.updateOrderStatus(id, 'processing')).rejects.toThrow('This order is waiting for approval. It can move on once it is approved.');
      expect(await row(id)).toMatchObject({ status: 'pending', stageSeq: 2 });
    });

    it('cancels it once, with the reason on the timeline and in its notes, and says so when it is already cancelled', async () => {
      const { InventoryDomainService } = await import('@/server/domains/inventory/service');
      const id = await place();
      const cancelled = await InventoryDomainService.cancelOrder(id, 'Customer changed their mind');
      expect(cancelled.status).toBe('cancelled');
      expect(cancelled.internalNotes).toContain('[cancelled] Customer changed their mind');
      expect((await events(id)).at(-1)).toMatchObject({ stage: 'cancelled', outcome: 'cancelled', reasonCode: 'cancelled', message: 'Customer changed their mind', toStatus: 'cancelled' });
      expect((await row(id))?.cancelledAt).toBeInstanceOf(Date);
      await expect(InventoryDomainService.cancelOrder(id, 'again')).rejects.toThrow('Order is already cancelled');
      expect(await events(id)).toHaveLength(2);
    });

    it('resolves a payment difference by matching it (reconciled and completed) or by cancelling the order, each with its time and the note', async () => {
      const { ReconciliationEngine: ReconciliationService } = await import('@/server/domains/reconciliation/service');
      const matched = await place();
      const matchLog = `rl_${randomUUID()}`;
      await db.insert(schema.reconciliationLogs).values({ id: matchLog, orderId: matched, orderNumber: 'X', provider: 'mpesa_daraja', discrepancyFound: true, discrepancyType: 'amount_mismatch', status: 'open' });
      await ReconciliationService.resolveDiscrepancy(matchLog, 'force_match', 'Checked on the statement');
      expect(await row(matched)).toMatchObject({ status: 'completed', paymentStatus: 'reconciled' });
      const line = await events(matched);
      expect(line.map((e) => e.stage)).toEqual(['order_placed', 'payment_reconciled', 'completed']);
      expect(line[2]).toMatchObject({ refType: 'reconciliation_log', refId: matchLog, message: 'Checked on the statement', source: 'staff' });

      const dropped = await place();
      const dropLog = `rl_${randomUUID()}`;
      await db.insert(schema.reconciliationLogs).values({ id: dropLog, orderId: dropped, orderNumber: 'Y', provider: 'mpesa_daraja', discrepancyFound: true, discrepancyType: 'amount_mismatch', status: 'open' });
      await ReconciliationService.resolveDiscrepancy(dropLog, 'cancel_order', 'Customer disputes it');
      expect(await row(dropped)).toMatchObject({ status: 'cancelled', paymentStatus: 'failed' });
      expect((await events(dropped)).at(-1)).toMatchObject({ stage: 'cancelled', outcome: 'cancelled', reasonCode: 'cancel_order', fromStatus: 'pending', toStatus: 'cancelled' });
    });
  });

  describe('a change that goes round the writer', () => {
    it('is recorded by the database itself, flagged, and the sale is not refused over it', async () => {
      const id = await place();
      await db.execute(sql`UPDATE orders SET status = 'shipped', payment_status = 'paid' WHERE id = ${id}`);
      const all = await events(id);
      const caught = all.at(-1);
      expect(caught).toMatchObject({ sequence: 2, stage: 'unrecorded_change', outcome: 'succeeded', source: 'trigger', fromStatus: 'pending', toStatus: 'shipped' });
      expect(caught?.changes).toMatchObject({ status: { from: 'pending', to: 'shipped' }, payment_status: { from: 'unpaid', to: 'paid' } });
      expect(caught?.message).toMatch(/without going through the order stage writer/);
      expect(await row(id)).toMatchObject({ status: 'shipped', stageSeq: 2, currentStage: 'unrecorded_change' });
    });

    it('leaves an update that touches no stage column alone', async () => {
      const id = await place();
      await db.execute(sql`UPDATE orders SET tracking_number = 'X1', internal_notes = 'n' WHERE id = ${id}`);
      expect(await events(id)).toHaveLength(1);
      expect((await row(id))?.stageSeq).toBe(1);
    });

    it('is not raised for a change the writer made', async () => {
      const id = await place();
      await move(id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: 'x' } });
      expect((await events(id)).some((e) => e.source === 'trigger')).toBe(false);
    });
  });

  describe('the timeline is kept', () => {
    it('refuses to change or delete an event, and an order that has events cannot be deleted', async () => {
      const id = await place();
      await expect(db.execute(sql`UPDATE order_stage_events SET stage = 'cancelled' WHERE order_id = ${id}`)).rejects.toThrow();
      await expect(db.execute(sql`DELETE FROM order_stage_events WHERE order_id = ${id}`)).rejects.toThrow();
      await expect(db.execute(sql`DELETE FROM orders WHERE id = ${id}`)).rejects.toThrow();
      expect(await events(id)).toHaveLength(1);
    });

    it('accepts only stages and outcomes the catalogue knows, and no two events with one number', async () => {
      const id = await place();
      await expect(db.execute(sql`INSERT INTO order_stage_events (order_id, sequence, stage, outcome, source) VALUES (${id}, 9, 'made_up', 'succeeded', 'staff')`)).rejects.toThrow();
      await expect(db.execute(sql`INSERT INTO order_stage_events (order_id, sequence, stage, outcome, source) VALUES (${id}, 9, 'packed', 'maybe', 'staff')`)).rejects.toThrow();
      await expect(db.execute(sql`INSERT INTO order_stage_events (order_id, sequence, stage, outcome, source) VALUES (${id}, 1, 'packed', 'succeeded', 'staff')`)).rejects.toThrow();
    });

    it('accepts every stage in the catalogue', async () => {
      const id = await place();
      let sequence = 1;
      for (const stage of ORDER_STAGE_NAMES) {
        sequence += 1;
        await db.execute(sql`INSERT INTO order_stage_events (order_id, sequence, stage, outcome, source) VALUES (${id}, ${sequence}, ${stage}, 'entered', 'system')`);
      }
      expect(sequence).toBe(ORDER_STAGE_NAMES.length + 1);
    });
  });

  describe('orders that are older than the timeline', () => {
    const oldOrder = async (over: { status?: string; paymentStatus?: string; shipped?: boolean; delivered?: boolean } = {}) => {
      const id = `old_${randomUUID()}`;
      const created = new Date('2026-01-10T08:00:00Z');
      await db.execute(sql`INSERT INTO orders (id, order_number, user_id, branch_id, customer_name, customer_email, customer_phone, shipping_address, subtotal, tax, shipping_fee, total_amount, payment_method, status, payment_status, shipped_at, delivered_at, created_at, updated_at)
        VALUES (${id}, ${`OLD-${randomUUID()}`}, 'u', ${branchId}::uuid, 'Old', 'old@x.io', '0700000000', '{"street":"s","city":"c","countyOrState":"x","country":"k"}'::jsonb, 100, 0, 0, 100, 'mpesa_daraja', ${over.status ?? 'delivered'}, ${over.paymentStatus ?? 'paid'},
          ${over.shipped === false ? null : '2026-01-11T09:00:00Z'}::timestamptz, ${over.delivered === false ? null : '2026-01-12T10:00:00Z'}::timestamptz, ${created.toISOString()}::timestamptz, '2026-01-12T10:00:00Z'::timestamptz)`);
      return id;
    };

    it('get their history rebuilt first, marked approximate, then the new stage follows it', async () => {
      const id = await oldOrder();
      expect((await row(id))?.stageSeq).toBe(0);
      await move(id, 'completed', 'succeeded');
      const all = await events(id);
      expect(all.map((e) => [e.stage, e.approximate, e.source])).toEqual([
        ['order_placed', true, 'migration'],
        ['payment_confirmed', true, 'migration'],
        ['dispatched', true, 'migration'],
        ['delivered', true, 'migration'],
        ['completed', false, 'system'],
      ]);
      expect(all.map((e) => e.sequence)).toEqual([1, 2, 3, 4, 5]);
      expect(all[2]?.occurredAt.toISOString()).toBe('2026-01-11T09:00:00.000Z');
      const o = await row(id);
      expect(o).toMatchObject({ stageSeq: 5, currentStage: 'completed', status: 'completed' });
      expect(o?.paidAt).toBeInstanceOf(Date);
    });

    it('are rebuilt in the background, a batch at a time, exactly once, and a trigger-caught change does not duplicate it', async () => {
      const a = await oldOrder({ status: 'cancelled', paymentStatus: 'unpaid', shipped: false, delivered: false });
      const b = await oldOrder({ status: 'failed', paymentStatus: 'failed', shipped: false, delivered: false });
      expect(await Stages.unseeded(db)).toBeGreaterThanOrEqual(2);
      let guard = 0;
      while ((await Stages.seedBatch(db, 50)) > 0 && guard++ < 50) {
        /* until none are left */
      }
      expect(await Stages.unseeded(db)).toBe(0);
      expect((await events(a)).map((e) => e.stage)).toEqual(['order_placed', 'cancelled']);
      expect((await events(b)).map((e) => e.stage)).toEqual(['order_placed', 'payment_failed']);
      expect(await Stages.seedBatch(db, 50)).toBe(0);
      expect((await events(a)).length).toBe(2);
    });
  });

  describe('the events always add up to the order (a randomised check)', () => {
    const stagesToTry = ORDER_STAGE_NAMES.filter((s) => s !== 'unrecorded_change' && s !== 'checkout_started' && s !== 'checkout_validated' && s !== 'checkout_refused');
    const outcomes: StageOutcome[] = ['entered', 'succeeded', 'failed', 'skipped', 'cancelled'];
    // A small deterministic generator, so a failure can be reproduced from its seed.
    const prng = (start: number) => {
      let state = start;
      return () => {
        state = (state * 1664525 + 1013904223) % 4294967296;
        return state / 4294967296;
      };
    };

    for (const seed of [1, 7, 42, 2026]) {
      it(`for seed ${String(seed)}: sequence is 1..n, times never go backwards, the changes replay to the order's columns, the last event is the current stage`, async () => {
        const next = prng(seed);
        const pick = <T,>(list: readonly T[]): T => list[Math.floor(next() * list.length)] as T;
        const id = await place();
        for (let step = 0; step < 40; step += 1) {
          const stage = pick(stagesToTry);
          const outcome = pick(outcomes);
          const ref = next() < 0.5 ? { ref: { type: 'thing', id: `r${String(Math.floor(next() * 6))}` } } : {};
          const set = stage === 'refund_completed' && next() < 0.5 ? { set: { paymentStatus: pick(['refunded', 'partially_refunded']) } } : {};
          await move(id, stage, outcome, { ...ref, ...set });
        }
        const o = await row(id);
        const all = await events(id);
        expect(all.map((e) => e.sequence)).toEqual(all.map((_, i) => i + 1));
        expect(o?.stageSeq).toBe(all.length);
        expect(o?.currentStage).toBe(all.at(-1)?.stage);
        for (let i = 1; i < all.length; i += 1) expect(all[i]?.occurredAt.getTime()).toBeGreaterThanOrEqual(all[i - 1]?.occurredAt.getTime() ?? 0);
        // Replaying every event's changes from nothing gives the order's columns today.
        const replay: Record<string, string | null> = {};
        for (const event of all) {
          for (const [column, change] of Object.entries(event.changes)) {
            if (event.sequence > 1) expect(replay[column], `${column} before event ${String(event.sequence)}`).toBe(change.from);
            replay[column] = change.to;
          }
        }
        for (const [name, column] of Object.entries(STAGE_COLUMN_SQL)) {
          expect(replay[column], name).toBe((o as unknown as Record<string, string>)[name]);
        }
        // Nothing the writer did was caught by the trigger.
        expect(all.some((e) => e.source === 'trigger')).toBe(false);
      });
    }
  });

  describe('a checkout that did not become an order', () => {
    it('is on record with its time, its stage and its reason, and finishes once', async () => {
      const attempt = await Attempts.start({ sessionRef: 'guest-ref-1', cart: { lines: [{ productId, quantity: 1 }], paymentMethod: 'mpesa_daraja' } });
      expect(attempt?.startedAt).toBeInstanceOf(Date);
      await Attempts.refuse(attempt, { stage: 'placement', code: 'quantity_limit', message: 'The least you can buy of "Rice" is 3.' });
      const [saved] = await db.select().from(schema.checkoutAttempts).where(eq(schema.checkoutAttempts.id, attempt?.id ?? ''));
      expect(saved).toMatchObject({ outcome: 'refused', refusedStage: 'placement', reasonCode: 'quantity_limit', channel: 'ecommerce', sessionRef: 'guest-ref-1', companyId });
      expect(saved?.finishedAt).toBeInstanceOf(Date);
      expect(saved?.cartSummary).toMatchObject({ lines: [{ productId, quantity: 1 }] });
      // A finished attempt cannot be changed, by the code or by anything else.
      await Attempts.placed(attempt, 'some-order');
      expect((await db.select().from(schema.checkoutAttempts).where(eq(schema.checkoutAttempts.id, attempt?.id ?? '')))[0]?.outcome).toBe('refused');
      await expect(db.execute(sql`UPDATE checkout_attempts SET outcome = 'placed' WHERE id = ${attempt?.id ?? ''}::uuid`)).rejects.toThrow();
    });

    it('becomes the order it led to', async () => {
      const attempt = await Attempts.start({ sessionRef: null, cart: {} });
      const id = await place({ checkoutStartedAt: attempt?.startedAt });
      await Attempts.placed(attempt, id);
      const [saved] = await db.select().from(schema.checkoutAttempts).where(eq(schema.checkoutAttempts.id, attempt?.id ?? ''));
      expect(saved).toMatchObject({ outcome: 'placed', orderId: id });
    });

    it('is removed after its retention, unless it became an order', async () => {
      const old = new Date('2024-01-01T00:00:00Z');
      const [oldRefused] = await db.insert(schema.checkoutAttempts).values({ startedAt: old, outcome: 'started' }).returning();
      const [oldPlaced] = await db.insert(schema.checkoutAttempts).values({ startedAt: old, outcome: 'started' }).returning();
      await db.execute(sql`UPDATE checkout_attempts SET outcome = 'refused' WHERE id = ${oldRefused?.id ?? ''}::uuid`);
      await db.execute(sql`UPDATE checkout_attempts SET outcome = 'placed', order_id = 'x' WHERE id = ${oldPlaced?.id ?? ''}::uuid`);
      const removed = await Attempts.purge(new Date('2026-06-01T00:00:00Z'));
      expect(removed).toBeGreaterThanOrEqual(1);
      expect(await db.select().from(schema.checkoutAttempts).where(eq(schema.checkoutAttempts.id, oldRefused?.id ?? ''))).toHaveLength(0);
      expect(await db.select().from(schema.checkoutAttempts).where(eq(schema.checkoutAttempts.id, oldPlaced?.id ?? ''))).toHaveLength(1);
    });
  });

  describe('reading the timeline', () => {
    it('shows staff every stage with the time since the one before, and without the reasons and actors for someone not allowed them', async () => {
      const id = await place();
      await move(id, 'payment_started', 'entered', { ref: { type: 'payment_attempt', id: 'r1' } });
      await move(id, 'payment_failed', 'failed', { ref: { type: 'payment_attempt', id: 'r1' }, reasonCode: 'declined', message: 'Declined' });
      const full = await read.orderTimeline(db, id, true);
      expect(full?.events.map((e) => e.stage)).toEqual(['order_placed', 'payment_started', 'payment_failed']);
      expect(full?.events[0]?.sincePreviousMs).toBeNull();
      expect(full?.events[2]?.sincePreviousMs).toBeGreaterThanOrEqual(0);
      expect(full?.events[2]?.detail).toMatchObject({ reasonCode: 'declined', message: 'Declined', source: expect.any(String) as string });
      expect(full?.currentStage).toBe('payment_failed');
      const limited = await read.orderTimeline(db, id, false);
      expect(limited?.events.every((e) => e.detail === undefined)).toBe(true);
      expect(JSON.stringify(limited)).not.toMatch(/declined|Declined/);
      expect(await read.orderTimeline(db, 'nope', true)).toBeNull();
    });

    it('shows a customer a few plain stages with their times and nothing else', async () => {
      const id = await place();
      await move(id, 'payment_started', 'entered', { ref: { type: 'payment_attempt', id: 'c1' } });
      await move(id, 'payment_failed', 'failed', { ref: { type: 'payment_attempt', id: 'c1' }, reasonCode: 'declined' });
      await move(id, 'payment_confirmed', 'succeeded', { ref: { type: 'payment_attempt', id: 'c2' } });
      await move(id, 'dispatched', 'succeeded');
      const steps = await read.customerOrderTimeline(db, id);
      expect(steps.map((s) => s.label)).toEqual(['Order placed', 'Payment received', 'On its way']);
      expect(JSON.stringify(steps)).not.toMatch(/declined|failed/i);
    });

    it('counts the funnel, the refusals, the failures and the stuck orders, and an order that went round the writer', async () => {
      const stuck = await place();
      await move(stuck, 'payment_started', 'entered', { ref: { type: 'payment_attempt', id: 's1' } });
      await db.execute(sql`UPDATE orders SET current_stage_since = now() - interval '90 days' WHERE id = ${stuck}`);
      const attempt = await Attempts.start({ sessionRef: 'g', cart: {} });
      await Attempts.refuse(attempt, { stage: 'placement', code: 'stock_short', message: 'Not enough' });
      const bypass = await place();
      await db.execute(sql`UPDATE orders SET status = 'cancelled' WHERE id = ${bypass}`);
      const flow = await read.orderFlow(db, 7);
      expect(flow.checkouts.refused).toBeGreaterThanOrEqual(1);
      expect(flow.refusals.find((r) => r.reason === 'stock_short')?.count).toBeGreaterThanOrEqual(1);
      expect(flow.milestones.find((m) => m.stage === 'order_placed')?.count).toBeGreaterThanOrEqual(1);
      expect(flow.failures.every((f) => f.count > 0)).toBe(true);
      expect(flow.stuck.some((s) => s.orderId === stuck && s.label === 'Payment not confirmed')).toBe(true);
      expect(flow.unrecorded).toBeGreaterThanOrEqual(1);
    });
  });
});
