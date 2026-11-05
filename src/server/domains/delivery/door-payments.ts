import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { cashCustodyEntries, deliveries, deliveryLines, deliveryDoorSettings, deliveryRiders, financeSettings, orderItems, orders, paymentMethods } from '@/server/db/drizzle/schema';
import { CUSTODY_WORDS, custodyBalance, doorAmount, fromCents, markProblem, toCents, type CustodyKind } from '@/lib/door-payment';
import { isLive } from '@/lib/delivery-document';
import { firstNonZero } from '@/lib/values';
import { OrderStages } from '@/server/domains/orders/stages';
import { InventoryReservationService } from '@/server/domains/inventory/reservation-service';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import type { CustomerMasterService } from '@/server/domains/customers/master-service';
import type { DeliveryDocuments, DocActor, DocRefusal, DocResult } from './documents';
import type { RiderSelf } from './riders';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);
const PAGE = 25;

export interface DoorSettingsView {
  cashMethodId: string | null;
  cashMethodName: string | null;
  version: number;
}

export interface CustodyRiderView {
  riderId: string;
  name: string;
  status: string;
  /** Cash the rider holds now, as exact money. */
  balance: string;
  collectedToday: string;
  lastAt: string | null;
}

export interface CustodyEntryView {
  id: string;
  riderId: string;
  riderName: string;
  kind: CustodyKind;
  kindWords: string;
  amount: string;
  currency: string;
  deliveryNumber: string | null;
  orderNumber: string | null;
  note: string | null;
  createdAt: string;
}

/**
 * Cash taken at the door. The office chooses how it is received (a payment method of kind cash, which says which account holds it),
 * marks a delivery to be paid there, and the rider collects exactly what is due: that puts the money in the rider's custody (a ledger
 * that is never edited), pays the order and books the sale through the payment method's account, so the cash sits in "cash with
 * riders" until it is handed in. Nothing the phone says about money is trusted: the amount due is read from the order here.
 */
export class DoorPayments {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly documents: Pick<DeliveryDocuments, 'recordNote'>,
    private readonly customers: Pick<CustomerMasterService, 'applyOrderPayment'>,
  ) {}

  // ── How cash at the door is received ─────────────────────────────────────────────────────────────────────────────

  async settings(companyId: string): Promise<DoorSettingsView> {
    const [row] = await this.db
      .select({ s: deliveryDoorSettings, name: paymentMethods.name })
      .from(deliveryDoorSettings)
      .leftJoin(paymentMethods, eq(paymentMethods.id, deliveryDoorSettings.cashMethodId))
      .where(eq(deliveryDoorSettings.companyId, companyId));
    return { cashMethodId: row?.s.cashMethodId ?? null, cashMethodName: row?.name ?? null, version: row?.s.version ?? 0 };
  }

  /** A payment method of kind cash that is switched on. Its account is where the cash is booked until it is handed in. */
  async setCashMethod(actor: DocActor, input: { cashMethodId?: unknown; expectedVersion?: unknown }): Promise<DocResult<DoorSettingsView>> {
    if (typeof input.cashMethodId !== 'string' || input.cashMethodId === '') return fail('bad_input', 'Choose the payment method cash at the door is received through.');
    const methodId = input.cashMethodId;
    const version = typeof input.expectedVersion === 'number' ? input.expectedVersion : 0;
    return await this.db.transaction(async (tx): Promise<DocResult<DoorSettingsView>> => {
      const [method] = await tx.select({ id: paymentMethods.id, kind: paymentMethods.kind, enabled: paymentMethods.enabled, name: paymentMethods.name }).from(paymentMethods).where(and(eq(paymentMethods.id, methodId), eq(paymentMethods.companyId, actor.companyId)));
      if (method === undefined) return fail('not_found', 'That payment method could not be found.');
      if (method.kind !== 'cash') return fail('bad_input', 'Choose a payment method of kind cash.');
      if (!method.enabled) return fail('bad_input', 'That payment method is switched off.');
      await tx.insert(deliveryDoorSettings).values({ companyId: actor.companyId }).onConflictDoNothing();
      const [row] = await tx.select().from(deliveryDoorSettings).where(eq(deliveryDoorSettings.companyId, actor.companyId)).for('update');
      if (row === undefined) return fail('not_found', 'The setting could not be found.');
      if (version !== 0 && version !== row.version) return fail('conflict', 'Someone else changed this while you were looking. Reload to see their change.');
      if (row.cashMethodId !== methodId) {
        await tx.update(deliveryDoorSettings).set({ cashMethodId: methodId, version: row.version + 1, updatedBy: actor.userId, updatedAt: new Date() }).where(eq(deliveryDoorSettings.companyId, actor.companyId));
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'door_payments', id: actor.companyId }, action: 'door_payments.method_set', actor: { type: 'user', id: actor.userId }, from: row.cashMethodId, to: methodId }, tx);
      }
      return { ok: true, data: { cashMethodId: methodId, cashMethodName: method.name, version: row.cashMethodId === methodId ? row.version : row.version + 1 } };
    });
  }

  // ── Marking a delivery to be paid at the door ────────────────────────────────────────────────────────────────────

  /** Facts for the rule: the delivery, its order, and how much of the order is (or is not) on it. */
  private async markFacts(tx: Tx, actor: DocActor, row: typeof deliveries.$inferSelect) {
    const [order] = await tx.select().from(orders).where(eq(orders.id, row.orderId));
    if (order === undefined) return null;
    const [fin] = await tx.select({ base: financeSettings.baseCurrency }).from(financeSettings).where(eq(financeSettings.companyId, actor.companyId));
    const door = await this.settings(actor.companyId);
    const ordered = await tx.select({ productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, row.orderId));
    const lines = await tx
      .select({ deliveryId: deliveryLines.deliveryId, productId: deliveryLines.productId, quantity: deliveryLines.quantity, picked: deliveryLines.picked, status: deliveries.status })
      .from(deliveryLines)
      .innerJoin(deliveries, eq(deliveries.id, deliveryLines.deliveryId))
      .where(eq(deliveries.orderId, row.orderId));
    const live = lines.filter((l) => isLive(l.status));
    const orderedBy = new Map<string, number>();
    for (const o of ordered) orderedBy.set(o.productId, (orderedBy.get(o.productId) ?? 0) + o.quantity);
    const here = new Map<string, number>();
    let elsewhere = 0;
    for (const l of live) {
      const q = Number(l.picked ?? l.quantity);
      if (l.deliveryId === row.id) here.set(l.productId, (here.get(l.productId) ?? 0) + q);
      else elsewhere += q;
    }
    let unplanned = 0;
    for (const [productId, q] of orderedBy) unplanned += Math.max(0, q - (here.get(productId) ?? 0));
    return { order, base: fin?.base ?? 'KES', door, unplanned: Math.round(unplanned * 1000) / 1000, elsewhere: Math.round(elsewhere * 1000) / 1000 };
  }

  /**
   * Lets the delivery go out to be paid in cash at the door: the order's total becomes the amount due. Refused unless the rules hold
   * (see `markProblem`); the person and their reason are kept on the delivery, in its history and in the decision log.
   */
  async mark(actor: DocActor, deliveryId: string, input: { reason?: unknown }): Promise<DocResult<{ amount: string }>> {
    const reason = text(input.reason, 300);
    if (reason === null || reason.length < 5) return fail('bad_input', 'Say why this order may be paid at the door, in a few words.');
    return await this.db.transaction(async (tx): Promise<DocResult<{ amount: string }>> => {
      const [row] = await tx.select().from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That delivery could not be found.');
      // The order is locked too, so a payment arriving at the same moment cannot pass the check and then be doubled at the door.
      await tx.select({ id: orders.id }).from(orders).where(eq(orders.id, row.orderId)).for('update');
      const facts = await this.markFacts(tx, actor, row);
      if (facts === null) return fail('not_found', 'The order of this delivery could not be found.');
      const problem = markProblem({
        method: row.method,
        status: row.status,
        orderPaymentStatus: facts.order.paymentStatus,
        orderPaymentMethod: facts.order.paymentMethod,
        orderStatus: facts.order.status,
        orderCurrency: facts.order.currency,
        baseCurrency: facts.base,
        tendered: Number(facts.order.tenderedAmount),
        unplanned: facts.unplanned,
        carriedElsewhere: facts.elsewhere,
        methodChosen: facts.door.cashMethodId !== null,
        alreadyMarked: row.doorAmount !== null,
      });
      if (problem !== null) return fail('not_allowed', problem);
      const amount = doorAmount(facts.order.totalAmount);
      if (toCents(amount) <= 0) return fail('not_allowed', 'There is nothing to collect: this order has no amount due.');
      await tx.update(deliveries).set({ doorAmount: amount, doorMarkedBy: actor.userId, doorMarkedAt: new Date(), doorReason: reason }).where(eq(deliveries.id, deliveryId));
      await this.documents.recordNote(tx, actor, deliveryId, 'door_marked', reason, { amount });
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id: deliveryId }, action: 'delivery.door_marked', actor: { type: 'user', id: actor.userId }, reason: { text: reason }, outcome: { amount } }, tx);
      return { ok: true, data: { amount } };
    });
  }

  /** Takes it back, before the delivery goes out. After that the rider already has the amount to collect. */
  async unmark(actor: DocActor, deliveryId: string, input: { reason?: unknown }): Promise<DocResult<null>> {
    const reason = text(input.reason, 300);
    if (reason === null || reason.length < 5) return fail('bad_input', 'Say why it is no longer to be paid at the door, in a few words.');
    return await this.db.transaction(async (tx): Promise<DocResult<null>> => {
      const [row] = await tx.select().from(deliveries).where(and(eq(deliveries.id, deliveryId), eq(deliveries.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That delivery could not be found.');
      if (row.doorAmount === null) return fail('not_allowed', 'This delivery is not marked to be paid at the door.');
      if (!['draft', 'released', 'picking', 'packed', 'ready'].includes(row.status)) return fail('not_allowed', 'It can only be taken back before it goes out.');
      await tx.update(deliveries).set({ doorAmount: null, doorMarkedBy: null, doorMarkedAt: null, doorReason: null }).where(eq(deliveries.id, deliveryId));
      await this.documents.recordNote(tx, actor, deliveryId, 'door_unmarked', reason, { amount: row.doorAmount });
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id: deliveryId }, action: 'delivery.door_unmarked', actor: { type: 'user', id: actor.userId }, reason: { text: reason } }, tx);
      return { ok: true, data: null };
    });
  }

  // ── The rider collects ───────────────────────────────────────────────────────────────────────────────────────────

  /**
   * Inside the transaction that marks the stop delivered: the cash goes into the rider's custody, once (the key is the delivery's),
   * the order is paid through the cash method, and its timeline says so. After the transaction commits, `followUp` stocks the order
   * and queues the sale for the books; if that fails, `finishPosting` does it again, so a paid order never waits on a retry by hand.
   */
  async collectIn(tx: Tx, self: RiderSelf, row: typeof deliveries.$inferSelect): Promise<DocResult<{ orderId: string }>> {
    if (row.doorAmount === null) return fail('not_allowed', 'This delivery is not to be paid at the door.');
    const door = await this.settings(self.companyId);
    if (door.cashMethodId === null) return fail('not_allowed', 'Cash at the door is not set up. Ask the office.');
    const [order] = await tx.select().from(orders).where(eq(orders.id, row.orderId)).for('update');
    if (order === undefined) return fail('not_found', 'The order of this delivery could not be found.');
    if (order.paymentStatus === 'paid') return fail('conflict', 'This order has already been paid, so no cash is to be taken. Tell the office.');
    const amount = row.doorAmount;
    await tx.insert(cashCustodyEntries).values({ companyId: self.companyId, riderId: self.riderId, kind: 'collected', amount, currency: order.currency, deliveryId: row.id, orderId: row.orderId, key: `collect:${row.id}`, actorId: self.userId });
    await OrderStages.moveIn(tx, row.orderId, 'payment_confirmed', 'succeeded', {
      ref: { type: 'door_cash', id: row.id },
      source: 'staff',
      actor: { type: 'user', id: self.userId },
      fields: { paymentMethod: 'cash_at_door', paymentMethodId: door.cashMethodId, transactionReference: `DOOR-${row.number}` },
      detail: { delivery: row.number, amount, rider: self.name },
    });
    return { ok: true, data: { orderId: row.orderId } };
  }

  /** After the commit: the order's stock is settled and the sale is queued for the books. Safe to run again. */
  async followUp(orderId: string): Promise<boolean> {
    try {
      await InventoryReservationService.fulfilOrder(orderId);
      await this.customers.applyOrderPayment(orderId);
      return true;
    } catch (error) {
      console.error('[door-payments] paid at the door but follow-up failed', orderId, error);
      return false;
    }
  }

  /** Runs the follow-up again for cash that was collected but whose order was not stocked or booked. */
  async finishPosting(companyId: string): Promise<{ checked: number; finished: number }> {
    const rows = await this.db
      .select({ orderId: cashCustodyEntries.orderId })
      .from(cashCustodyEntries)
      .where(and(eq(cashCustodyEntries.companyId, companyId), eq(cashCustodyEntries.kind, 'collected'), sql`NOT EXISTS (SELECT 1 FROM finance_sales_postings p WHERE p.company_id = ${cashCustodyEntries.companyId} AND p.kind = 'cash_sale' AND p.subject_id = ${cashCustodyEntries.orderId})`))
      .limit(200);
    let finished = 0;
    for (const r of rows) if (r.orderId !== null && (await this.followUp(r.orderId))) finished += 1;
    return { checked: rows.length, finished };
  }

  // ── What riders hold ─────────────────────────────────────────────────────────────────────────────────────────────

  /** Every rider who has held cash, with what they hold now. Three reads however many riders there are. */
  async balances(companyId: string, today: string): Promise<CustodyRiderView[]> {
    const rows = await this.db
      .select({ riderId: cashCustodyEntries.riderId, kind: cashCustodyEntries.kind, amount: cashCustodyEntries.amount, at: cashCustodyEntries.createdAt })
      .from(cashCustodyEntries)
      .where(eq(cashCustodyEntries.companyId, companyId));
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.riderId))];
    const riders = await this.db.select({ id: deliveryRiders.id, name: deliveryRiders.name, status: deliveryRiders.status }).from(deliveryRiders).where(and(eq(deliveryRiders.companyId, companyId), inArray(deliveryRiders.id, ids)));
    const by = new Map(riders.map((r) => [r.id, r]));
    return ids
      .map((id) => {
        const mine = rows.filter((r) => r.riderId === id);
        const today1 = mine.filter((r) => r.kind === 'collected' && r.at.toISOString().slice(0, 10) === today).reduce((n, r) => n + toCents(r.amount), 0);
        const last = mine.reduce<Date | null>((a, r) => (a === null || r.at > a ? r.at : a), null);
        return { riderId: id, name: by.get(id)?.name ?? 'Rider', status: by.get(id)?.status ?? 'ended', balance: fromCents(custodyBalance(mine.map((r) => ({ kind: r.kind, cents: toCents(r.amount) })))), collectedToday: fromCents(today1), lastAt: last?.toISOString() ?? null };
      })
      .sort((a, b) => firstNonZero(toCents(b.balance) - toCents(a.balance), a.name.localeCompare(b.name)));
  }

  /** What one rider holds, for their own screen. */
  async heldBy(self: RiderSelf): Promise<string> {
    const rows = await this.db.select({ kind: cashCustodyEntries.kind, amount: cashCustodyEntries.amount }).from(cashCustodyEntries).where(and(eq(cashCustodyEntries.companyId, self.companyId), eq(cashCustodyEntries.riderId, self.riderId)));
    return fromCents(custodyBalance(rows.map((r) => ({ kind: r.kind, cents: toCents(r.amount) }))));
  }

  /** The custody ledger, newest first, one page at a time. */
  async entries(companyId: string, input: { riderId?: unknown; cursor?: unknown }): Promise<{ rows: CustodyEntryView[]; nextCursor: string | null }> {
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const riderId = typeof input.riderId === 'string' && input.riderId !== '' ? input.riderId : null;
    const rows = await this.db
      .select({ e: cashCustodyEntries, cursorKey: sql<string>`${cashCustodyEntries.createdAt}::text`, riderName: deliveryRiders.name, deliveryNumber: deliveries.number, orderNumber: orders.orderNumber })
      .from(cashCustodyEntries)
      .innerJoin(deliveryRiders, eq(deliveryRiders.id, cashCustodyEntries.riderId))
      .leftJoin(deliveries, eq(deliveries.id, cashCustodyEntries.deliveryId))
      .leftJoin(orders, eq(orders.id, cashCustodyEntries.orderId))
      .where(
        and(
          eq(cashCustodyEntries.companyId, companyId),
          riderId === null ? undefined : eq(cashCustodyEntries.riderId, riderId),
          after === null ? undefined : sql`(${cashCustodyEntries.createdAt}, ${cashCustodyEntries.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(cashCustodyEntries.createdAt), desc(cashCustodyEntries.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    const last = page[page.length - 1];
    return {
      rows: page.map((r) => ({ id: r.e.id, riderId: r.e.riderId, riderName: r.riderName, kind: r.e.kind, kindWords: CUSTODY_WORDS[r.e.kind], amount: r.e.amount, currency: r.e.currency, deliveryNumber: r.deliveryNumber, orderNumber: r.orderNumber, note: r.e.note, createdAt: r.e.createdAt.toISOString() })),
      nextCursor: rows.length > PAGE && last !== undefined ? encodeCursor({ k: last.cursorKey, id: last.e.id }) : null,
    };
  }
}
