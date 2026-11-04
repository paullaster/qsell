import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, deliveries, deliveryAttempts, deliveryEvents, deliveryProofs, deliveryRiderSettings, deliveryRiders, deliveryShipments, deliveryLines, deliveryReturns, orderDeliveries, orderItems, orders, products, stockReservations, stockSettings, unitsOfMeasure, type ReturnEffects } from '@/server/db/drizzle/schema';
import {
  ACTION_WORDS,
  FAILURE_REASONS,
  MAX_DELIVERY_ATTEMPTS,
  STAGES_FOR,
  STATUS_WORDS,
  actionsFrom,
  allocate,
  checkPicked,
  isDocumentMethod,
  isFailureReason,
  isLive,
  isOver,
  nextStatus,
  orderDeliveryStatus,
  type DeliveryAction,
  type DeliveryFacts,
  type DeliveryStatus,
  type OrderDeliveryStatus,
  type QuantityLine,
} from '@/lib/delivery-document';
import { quantityProblem } from '@/lib/unit-rules';
import type { DestinationRecord } from '@/lib/order-delivery';
import { OrderStages } from '@/server/domains/orders/stages';
import type { OrderStage } from '@/lib/order-stages';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { decodeCursor, encodeCursor } from '@/server/domains/lookups/request';
import { DISPOSITION_WORDS, dispositionsFor, isIssueMoment, issuesAt, returnProblem, type IssueMoment, type ReturnDisposition, type ReturnableLine } from '@/lib/stock-issue';
import type { StockReservations } from '@/server/domains/stock/reservations';
import { StockError } from '@/server/domains/stock/errors';
import { codeFromBytes, isProofRule, usesCode } from '@/lib/delivery-proof';
import { kindForStep, messageKey } from '@/lib/delivery-messages';
import type { DeliveryMessages } from './messages';
import { orderReadinessProblem } from './order-readiness';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface DocActor {
  companyId: string;
  userId: string;
}

export type DocRefusal = 'not_found' | 'bad_input' | 'not_allowed' | 'conflict' | 'order_not_ready' | 'nothing_left' | 'wrong_method';
export type DocResult<T> = { ok: true; data: T } | { ok: false; reason: DocRefusal; message: string };

const fail = (reason: DocRefusal, message: string): { ok: false; reason: DocRefusal; message: string } => ({ ok: false, reason, message });
const num = (value: string | null): number => (value === null ? 0 : Number(value));
const text = (value: unknown, max: number): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, max) : null);

export interface DeliveryLineView {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  picked: number | null;
  delivered: number;
  /** How much of it has left the shelf for this delivery. */
  issued: number;
  /** For a returned delivery: how much could come back, what may be done with it, and the receipt once it is made. */
  back: {
    could: number;
    choices: { id: ReturnDisposition; name: string; means: string }[];
    /** The receipt in force (the highest revision), and whether it can still be corrected. */
    receipt: { quantity: number; disposition: ReturnDisposition; words: string; receivedAt: string; revision: number; correctionReason: string | null; correctable: boolean } | null;
    /** Earlier revisions of the receipt, oldest first. */
    earlier: { revision: number; quantity: number; words: string; receivedAt: string; correctionReason: string | null }[];
    /** What a correction may choose. */
    correctTo: { id: ReturnDisposition; name: string; means: string }[];
  } | null;
}

export interface DeliveryEventView {
  sequence: number;
  action: string;
  actionWords: string;
  fromStatus: string | null;
  toStatus: string | null;
  actorId: string | null;
  reasonCode: string | null;
  note: string | null;
  detail: Record<string, unknown>;
  occurredAt: string;
}

/** One go at the door by a rider, with what they showed. A photo is opened through a signed link after an access check, never by its id. */
export interface DeliveryAttemptView {
  attemptNo: number;
  result: string;
  resultWords: string;
  riderName: string;
  receivedBy: string | null;
  note: string | null;
  place: { lat: number; lng: number } | null;
  occurredAt: string;
  /** The phone's own clock, only for the record. */
  clientTime: string | null;
  proofs: { id: string; kind: 'code' | 'photo' }[];
}

export interface DeliveryView {
  id: string;
  number: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  method: 'own_fleet' | 'courier';
  status: DeliveryStatus;
  statusWords: string;
  branch: { id: string; name: string };
  destination: DestinationRecord;
  recipientName: string | null;
  recipientPhone: string | null;
  notes: string | null;
  courierName: string | null;
  trackingNumber: string | null;
  receivedBy: string | null;
  failedAttempts: number;
  /** A code was made for the customer to say at the door. The code itself is the customer's, and is not shown here. */
  hasCode: boolean;
  version: number;
  createdAt: string;
  releasedAt: string | null;
  dispatchedAt: string | null;
  deliveredAt: string | null;
  lines: DeliveryLineView[];
  events: DeliveryEventView[];
  attempts: DeliveryAttemptView[];
  /** What can be done next, with the words for the button. */
  actions: { action: DeliveryAction; words: string }[];
}

export interface DeliveryListItem {
  id: string;
  number: string;
  orderNumber: string;
  customerName: string;
  method: 'own_fleet' | 'courier';
  status: DeliveryStatus;
  statusWords: string;
  branchName: string;
  lineCount: number;
  createdAt: string;
}

export interface OrderDeliveries {
  state: OrderDeliveryStatus['state'];
  /** Per product: ordered, on live deliveries, delivered and still open, with the product's name. */
  lines: (OrderDeliveryStatus['lines'][number] & { productName: string; sku: string; decimals: number })[];
  deliveries: { id: string; number: string; status: DeliveryStatus; statusWords: string; lineCount: number }[];
  /** Whether the order is one that gets a delivery document at all, and if not why. */
  eligible: { ok: true } | { ok: false; reason: string };
}

const PAGE = 25;

/** The history line for an action, in words. */
function eventWords(action: string): string {
  if (action === 'created') return 'Made';
  if (action === 'amend') return 'Details changed';
  if (action === 'receive_return') return 'Returned goods received';
  if (action === 'correct_return') return 'Receipt corrected';
  if (action === 'courier_update') return 'Courier news';
  return Object.prototype.hasOwnProperty.call(ACTION_WORDS, action) ? ACTION_WORDS[action as DeliveryAction] : action;
}

/**
 * An order's deliveries: made from what the order has left to deliver, taken from released to delivered one step at a time, each step
 * checked against the rules in `delivery-document.ts`, recorded in the delivery's own kept history and on the order's timeline, in
 * the one transaction that changes it. A delivery is locked while it changes, so two people cannot do the same step twice, and
 * an order is locked while deliveries are made, so together they never carry more than the order.
 */
export class DeliveryDocuments {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly numbering: Pick<NumberSeriesService, 'assign'>,
    private readonly stock: Pick<StockReservations, 'consumePartIn' | 'receiveGoodsBackIn' | 'undoReceiptIn'>,
    private readonly messages: Pick<DeliveryMessages, 'enqueueIn'>,
  ) {}

  // ── Making a delivery ────────────────────────────────────────────────────────────────────────────────────────────

  async create(actor: DocActor, orderId: string, input: { lines?: { productId: string; quantity: number }[] | null; notes?: unknown }): Promise<DocResult<{ id: string; number: string }>> {
    return await this.db.transaction(async (tx): Promise<DocResult<{ id: string; number: string }>> => {
      // The order is locked, so two deliveries being made at once cannot both take the same goods.
      const [order] = await tx
        .select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus, paymentMethod: orders.paymentMethod })
        .from(orders)
        .where(eq(orders.id, orderId))
        .for('update');
      if (order === undefined) return fail('not_found', 'That order could not be found.');
      const [chosen] = await tx.select().from(orderDeliveries).where(and(eq(orderDeliveries.orderId, orderId), eq(orderDeliveries.companyId, actor.companyId)));
      if (chosen === undefined) return fail('not_found', 'That order has no delivery to make.');
      if (!isDocumentMethod(chosen.method)) return fail('wrong_method', chosen.method === 'pickup' ? 'This order is collected from a branch, so it has no delivery. Hand it over from its Collection panel.' : 'This kind of delivery is not made here yet.');
      if (chosen.branchId === null) return fail('bad_input', 'This order has no branch to send the goods from.');
      const closed = orderReadinessProblem(order);
      if (closed !== null && closed.reason === 'order_closed') return fail('order_not_ready', closed.message);

      const ordered = await tx.select({ productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, orderId));
      const committed = await this.committedIn(tx, orderId);
      const made = allocate(ordered.map((l) => ({ productId: l.productId, quantity: l.quantity })), committed, input.lines ?? null);
      if (!made.ok) return fail(made.error.includes('nothing left') ? 'nothing_left' : 'bad_input', made.error);
      const decimals = await this.decimalsOf(tx, made.lines.map((l) => l.productId));
      for (const line of made.lines) {
        const unit = decimals.get(line.productId);
        const problem = unit === undefined ? null : quantityProblem(line.quantity, unit.decimals, unit.name, 'A quantity on the delivery');
        if (problem !== null) return fail('bad_input', problem);
      }

      const id = crypto.randomUUID();
      const { number } = await this.numbering.assign('sales_delivery', { companyId: actor.companyId, date: businessDate(), document: { kind: 'sales_delivery', id } }, tx);
      await tx.insert(deliveries).values({
        id,
        companyId: actor.companyId,
        orderId,
        number,
        method: chosen.method,
        branchId: chosen.branchId,
        destination: chosen.destination,
        recipientName: chosen.recipientName,
        recipientPhone: chosen.recipientPhone,
        notes: text(input.notes, 300) ?? chosen.notes,
        createdBy: actor.userId,
      });
      await tx.insert(deliveryLines).values(made.lines.map((l) => ({ deliveryId: id, productId: l.productId, quantity: String(l.quantity) })));
      await this.event(tx, id, 'created', actor, null, 'draft', { detail: { lines: made.lines.length } });
      await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id }, action: 'delivery.document_created', actor: { type: 'user', id: actor.userId }, to: 'draft', inputs: { orderId, number } }, tx);
      return { ok: true, data: { id, number } };
    });
  }

  // ── The steps ────────────────────────────────────────────────────────────────────────────────────────────────────

  async release(actor: DocActor, id: string, expectedVersion?: number) {
    return await this.step(actor, id, 'release', expectedVersion, (_tx, ctx) => {
      const problem = orderReadinessProblem(ctx.order);
      if (problem !== null) return Promise.resolve(fail('order_not_ready', problem.message));
      return Promise.resolve({ set: { releasedAt: new Date() } });
    });
  }

  async startPicking(actor: DocActor, id: string, expectedVersion?: number) {
    return await this.step(actor, id, 'start_picking', expectedVersion, () => Promise.resolve({ set: {} }));
  }

  /** What was picked, line by line. A short pick leaves the difference open on the order. Can be corrected until the delivery is packed. */
  async recordPicked(actor: DocActor, id: string, input: { picked: unknown; note?: unknown }, expectedVersion?: number) {
    const counted = Array.isArray(input.picked) ? input.picked : null;
    if (counted === null) return fail('bad_input', 'Say how much of each product was picked.');
    const picked: QuantityLine[] = [];
    for (const row of counted) {
      const r = typeof row === 'object' && row !== null ? (row as Record<string, unknown>) : {};
      if (typeof r.productId !== 'string' || typeof r.quantity !== 'number') return fail('bad_input', 'Say how much of each product was picked.');
      picked.push({ productId: r.productId, quantity: r.quantity });
    }
    return await this.step(actor, id, 'record_picked', expectedVersion, async (tx, ctx) => {
      const checked = checkPicked(ctx.lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity) })), picked);
      if (!checked.ok) return fail('bad_input', checked.error);
      const decimals = await this.decimalsOf(tx, checked.picked.map((l) => l.productId));
      for (const line of checked.picked) {
        const unit = decimals.get(line.productId);
        const problem = unit === undefined ? null : quantityProblem(line.quantity, unit.decimals, unit.name, 'A picked quantity');
        if (problem !== null) return fail('bad_input', problem);
      }
      for (const line of checked.picked) {
        await tx.update(deliveryLines).set({ picked: String(line.quantity) }).where(and(eq(deliveryLines.deliveryId, id), eq(deliveryLines.productId, line.productId)));
      }
      return { set: {}, detail: { picked: checked.picked, short: checked.short }, note: text(input.note, 300), stageDetail: { short: checked.short } };
    });
  }

  async markPacked(actor: DocActor, id: string, expectedVersion?: number) {
    return await this.step(actor, id, 'mark_packed', expectedVersion, (_tx, ctx) => {
      if (ctx.lines.some((l) => l.picked === null)) return Promise.resolve(fail('bad_input', 'Record what was picked before marking it packed.'));
      return Promise.resolve({ set: { packedAt: new Date() } });
    });
  }

  async markReady(actor: DocActor, id: string, expectedVersion?: number) {
    return await this.step(actor, id, 'mark_ready', expectedVersion, () => Promise.resolve({ set: { readyAt: new Date() } }));
  }

  /**
   * Sends it out. A courier delivery says which courier has it and, when the courier gave one, its tracking number; the courier's
   * shipment is recorded with it. A run passes its own words (`note`, `detail`) so the history says which run took it. With `tx` the
   * step is made inside the caller's transaction (a run starts all its stops or none).
   */
  async dispatch(actor: DocActor, id: string, input: { courierName?: unknown; trackingNumber?: unknown; note?: string; detail?: Record<string, unknown> }, expectedVersion?: number, tx?: Tx) {
    return await this.step(
      actor,
      id,
      'dispatch',
      expectedVersion,
      async (inner, ctx) => {
        const problem = orderReadinessProblem(ctx.order);
        if (problem !== null) return fail('order_not_ready', problem.message);
        const courierName = text(input.courierName, 120);
        if (ctx.row.method === 'courier' && courierName === null) return fail('bad_input', 'Say which courier has it.');
        const trackingNumber = ctx.row.method === 'courier' ? text(input.trackingNumber, 120) : null;
        if (ctx.row.method === 'courier' && courierName !== null) {
          await inner
            .insert(deliveryShipments)
            .values({ companyId: actor.companyId, deliveryId: id, courierName, trackingNumber, status: 'in_transit' })
            .onConflictDoUpdate({ target: deliveryShipments.deliveryId, set: { courierName, trackingNumber, status: 'in_transit', lastUpdateAt: new Date() } });
        }
        // A delivery the shop's own rider carries gets the customer's code when the company asks for it as proof; a second try keeps the first.
        const [proofRow] = ctx.row.method === 'own_fleet' ? await inner.select({ proof: deliveryRiderSettings.proof }).from(deliveryRiderSettings).where(eq(deliveryRiderSettings.companyId, actor.companyId)) : [];
        const handoverCode = proofRow !== undefined && isProofRule(proofRow.proof) && usesCode(proofRow.proof) ? (ctx.row.handoverCode ?? codeFromBytes(randomBytes(4))) : ctx.row.handoverCode;
        return { set: { dispatchedAt: new Date(), courierName: ctx.row.method === 'courier' ? courierName : null, trackingNumber, handoverCode }, note: input.note ?? null, detail: input.detail ?? {} };
      },
      tx,
    );
  }

  /** Delivered, to someone who is named. Everything that was picked is delivered; a part of the order delivered is not the order delivered. */
  async deliver(actor: DocActor, id: string, input: { receivedBy?: unknown; note?: unknown }, expectedVersion?: number, tx?: Tx) {
    const receivedBy = text(input.receivedBy, 120);
    if (receivedBy === null) return fail('bad_input', 'Say who received it.');
    return await this.step(
      actor,
      id,
      'deliver',
      expectedVersion,
      async (inner) => {
        await inner.update(deliveryLines).set({ delivered: sql`COALESCE(${deliveryLines.picked}, ${deliveryLines.quantity})` }).where(eq(deliveryLines.deliveryId, id));
        return { set: { deliveredAt: new Date(), receivedBy }, note: text(input.note, 300), detail: { receivedBy } };
      },
      tx,
    );
  }

  /** The goods were not delivered this time. A reason from the list is needed, and the person says which if it is "another reason". */
  async failAttempt(actor: DocActor, id: string, input: { reasonCode?: unknown; note?: unknown }, expectedVersion?: number, tx?: Tx) {
    if (!isFailureReason(input.reasonCode)) return fail('bad_input', 'Choose why the delivery did not happen.');
    const reasonCode = input.reasonCode as string;
    const note = text(input.note, 300);
    if (reasonCode === 'other' && note === null) return fail('bad_input', 'Say what happened.');
    return await this.step(actor, id, 'fail_attempt', expectedVersion, () => Promise.resolve({ set: {}, bump: { failedAttempts: sql`${deliveries.failedAttempts} + 1` }, reasonCode, note, stageReason: reasonCode }), tx);
  }

  /** Another try: only while the limit has not been reached, and with a note on why it should work this time. */
  async reattempt(actor: DocActor, id: string, input: { note?: unknown }, expectedVersion?: number) {
    return await this.step(actor, id, 'reattempt', expectedVersion, (_tx, ctx) => {
      if (ctx.row.failedAttempts >= MAX_DELIVERY_ATTEMPTS) return Promise.resolve(fail('not_allowed', `This delivery has been tried ${String(MAX_DELIVERY_ATTEMPTS)} times. Return it to stock, or cancel the order.`));
      return Promise.resolve({ set: {}, note: text(input.note, 300) });
    });
  }

  /** The goods come back. They are open on the order again. Stock itself is put back by the goods issue and return slice. */
  async returnToStock(actor: DocActor, id: string, input: { reason?: unknown }, expectedVersion?: number) {
    const reason = text(input.reason, 300);
    if (reason === null || reason.length < 5) return fail('bad_input', 'Say why it is being returned, in a few words.');
    return await this.step(actor, id, 'return', expectedVersion, () => Promise.resolve({ set: { closedAt: new Date() }, note: reason, reasonCode: 'returned', stageReason: 'returned' }));
  }

  /** Cancelled before it goes out. What it carried is open on the order again. */
  async cancel(actor: DocActor, id: string, input: { reason?: unknown }, expectedVersion?: number) {
    const reason = text(input.reason, 300);
    if (reason === null || reason.length < 5) return fail('bad_input', 'Say why it is being cancelled, in a few words.');
    return await this.step(actor, id, 'cancel', expectedVersion, () => Promise.resolve({ set: { closedAt: new Date() }, note: reason, reasonCode: 'cancelled' }));
  }

  /** Corrections that do not change the state: who receives it and any note, until it goes out. */
  async amend(actor: DocActor, id: string, input: { recipientName?: unknown; recipientPhone?: unknown; notes?: unknown }, expectedVersion?: number): Promise<DocResult<DeliveryView>> {
    return await this.db.transaction(async (tx): Promise<DocResult<DeliveryView>> => {
      const [row] = await tx.select().from(deliveries).where(and(eq(deliveries.id, id), eq(deliveries.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That delivery could not be found.');
      if (expectedVersion !== undefined && expectedVersion !== row.version) return fail('conflict', 'Someone else changed this delivery while you were looking. Reload it to see their change.');
      if (row.status === 'out_for_delivery' || isOver(row.status)) return fail('not_allowed', 'A delivery that has gone out, or is finished, cannot be changed.');
      const next = { recipientName: text(input.recipientName, 120), recipientPhone: text(input.recipientPhone, 40), notes: text(input.notes, 300) };
      await tx.update(deliveries).set({ ...next, version: row.version + 1, updatedAt: new Date() }).where(eq(deliveries.id, id));
      await this.event(tx, id, 'amend', actor, row.status, row.status, { detail: { recipientName: next.recipientName, recipientPhone: next.recipientPhone } });
      return { ok: true, data: await this.viewIn(tx, actor.companyId, id) };
    });
  }

  // ── The one place a step is made ─────────────────────────────────────────────────────────────────────────────────

  private async step(
    actor: DocActor,
    id: string,
    action: DeliveryAction,
    expectedVersion: number | undefined,
    work: (tx: Tx, ctx: StepContext) => Promise<StepOutcome | { ok: false; reason: DocRefusal; message: string }>,
    outer?: Tx,
  ): Promise<DocResult<DeliveryView>> {
    // Inside the caller's transaction when there is one (a run starts all its stops or none); a nested one is a savepoint.
    return await (outer ?? this.db).transaction(async (tx): Promise<DocResult<DeliveryView>> => {
      const [row] = await tx.select().from(deliveries).where(and(eq(deliveries.id, id), eq(deliveries.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That delivery could not be found.');
      if (expectedVersion !== undefined && expectedVersion !== row.version) return fail('conflict', 'Someone else changed this delivery while you were looking. Reload it to see their change.');
      const to = nextStatus(row.status, action);
      if (to === null) return fail('not_allowed', `A delivery that is ${STATUS_WORDS[row.status].toLowerCase()} cannot be done this way (${ACTION_WORDS[action].toLowerCase()}).`);
      // The order is read under the delivery's lock: its payment and approval can change while a delivery waits.
      const [order] = await tx.select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus, paymentMethod: orders.paymentMethod, orderNumber: orders.orderNumber }).from(orders).where(eq(orders.id, row.orderId));
      if (order === undefined) return fail('not_found', 'The order of this delivery could not be found.');
      const lines = await tx.select().from(deliveryLines).where(eq(deliveryLines.deliveryId, id));
      const afterDelivery = async (): Promise<'delivered' | 'part_delivered'> => {
        const facts = await this.factsIn(tx, row.orderId, new Map([[id, { status: to, lines: lines.map((l) => ({ productId: l.productId, quantity: Number(l.quantity), picked: l.picked === null ? null : Number(l.picked), delivered: Number(l.picked ?? l.quantity) })) }]]));
        const ordered = await tx.select({ productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, row.orderId));
        return orderDeliveryStatus(ordered.map((o) => ({ productId: o.productId, quantity: o.quantity })), facts).state === 'delivered' ? 'delivered' : 'part_delivered';
      };
      const outcome = await work(tx, { row, lines, order, afterDelivery });
      if ('ok' in outcome) return outcome;

      const closing = isOver(to);
      await tx
        .update(deliveries)
        .set({ ...outcome.set, ...(outcome.bump ?? {}), status: to, version: row.version + 1, updatedAt: new Date(), ...(closing ? { closedAt: outcome.set.closedAt ?? new Date() } : {}) })
        .where(eq(deliveries.id, id));
      await this.event(tx, id, action, actor, row.status, to, { reasonCode: outcome.reasonCode ?? null, note: outcome.note ?? null, detail: outcome.detail ?? {} });

      // The stock leaves the shelf now if the shop issues it at this step; the part this delivery carries, nothing more.
      const issuedNow = await this.issueIn(tx, actor, row, action);

      // The order's timeline, in the same transaction: each stage with who did it and why, once for each time it is reached.
      const stages: OrderStage[] = [...STAGES_FOR[action]] as OrderStage[];
      if (issuedNow !== null) stages.push('stock_issued');
      if (action === 'deliver') stages.push(await afterDelivery());
      // The customer is told, when this step is one they are told about: queued now, in this transaction, and sent after it.
      const kind = kindForStep(action, stages.includes('delivered'));
      if (kind !== null) await this.messages.enqueueIn(tx, { companyId: actor.companyId, orderId: row.orderId, deliveryId: id, kind, key: messageKey(id, kind, action === 'fail_attempt' ? row.failedAttempts + 1 : row.failedAttempts) });
      for (const stage of stages) {
        await OrderStages.moveIn(tx, row.orderId, stage, stage === 'delivery_attempted' || stage === 'delivery_failed' ? 'failed' : 'succeeded', {
          actor: { type: 'user', id: actor.userId },
          ref: { type: 'delivery_stage', id: `${id}:${stage}:${String(row.failedAttempts)}:${String(row.version)}` },
          message: `${row.number} · ${ACTION_WORDS[action]}${outcome.note === undefined || outcome.note === null ? '' : `: ${outcome.note}`}`,
          ...(outcome.stageReason === undefined ? {} : { reasonCode: outcome.stageReason }),
          detail: { delivery: row.number, ...(stage === 'stock_issued' ? { at: action, ...issuedNow } : {}), ...(outcome.stageDetail ?? {}) },
        });
      }
      if (action === 'cancel' || action === 'return' || action === 'fail_attempt') {
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id }, action: `delivery.${action}`, actor: { type: 'user', id: actor.userId }, from: row.status, to, reason: { ...(outcome.reasonCode === undefined || outcome.reasonCode === null ? {} : { code: outcome.reasonCode }), text: outcome.note ?? null } }, tx);
      }
      return { ok: true, data: await this.viewIn(tx, actor.companyId, id) };
    });
  }

  /** The stock settings read inside the open transaction: one indexed row. Anything but the ledger issues at payment. */
  private async momentIn(tx: Tx, companyId: string): Promise<IssueMoment> {
    const [row] = await tx.select({ moment: stockSettings.issueMoment, ledger: stockSettings.ledgerMode }).from(stockSettings).where(eq(stockSettings.companyId, companyId));
    return row?.ledger === true && isIssueMoment(row.moment) ? row.moment : 'payment';
  }

  /**
   * Issues the stock this delivery carries, when the shop issues at this step: what was picked (or planned) less what has been issued,
   * from what the order holds. A product the order no longer holds (it was issued when the order was paid) is left alone, so nothing
   * is issued twice. Returns what was issued, or null when nothing was.
   */
  private async issueIn(tx: Tx, actor: DocActor, row: typeof deliveries.$inferSelect, action: DeliveryAction): Promise<{ issued: number; covered: number } | null> {
    if (!issuesAt(await this.momentIn(tx, actor.companyId), action)) return null;
    const lines = await tx.select().from(deliveryLines).where(eq(deliveryLines.deliveryId, row.id));
    const wanted = new Map<string, number>();
    for (const l of lines) {
      const left = Math.round((Number(l.picked ?? l.quantity) - Number(l.issued)) * 1000) / 1000;
      if (left > 0) wanted.set(l.productId, left);
    }
    if (wanted.size === 0) return null;
    const done = await this.stock.consumePartIn(tx, { companyId: actor.companyId, refType: 'order', refId: row.orderId, actor: actor.userId, key: row.id }, wanted);
    for (const [productId, covered] of done.coveredBy) await tx.update(deliveryLines).set({ issued: sql`${deliveryLines.issued} + ${covered}` }).where(and(eq(deliveryLines.deliveryId, row.id), eq(deliveryLines.productId, productId)));
    return done.covered > 0 ? { issued: done.issued, covered: done.covered } : null;
  }

  /**
   * Receives what came back with a returned delivery, product by product, with what is to be done with it. Goods this delivery issued
   * are counted back onto the shelf where they were held (or counted back and written off if spoilt); goods that never left the books
   * are written off if spoilt and otherwise need nothing; goods issued when the order was paid are kept for the order. The receipt is
   * kept, a product is received once, and a restock puts `returned_to_stock` on the order's timeline.
   */
  async receiveReturn(actor: DocActor, id: string, input: { lines?: unknown; note?: unknown }): Promise<DocResult<DeliveryView>> {
    const asked = Array.isArray(input.lines) ? (input.lines as unknown[]) : [];
    const lines = asked.map((l) => {
      const o = typeof l === 'object' && l !== null ? (l as Record<string, unknown>) : {};
      return { productId: typeof o.productId === 'string' ? o.productId : '', quantity: typeof o.quantity === 'number' ? o.quantity : Number.NaN, disposition: typeof o.disposition === 'string' ? o.disposition : '' };
    });
    const note = text(input.note, 300);
    try {
      return await this.receiveReturnIn(actor, id, lines, note);
    } catch (error) {
      // The shelf could not hold the goods again: nothing was received, and the person is told why.
      if (error instanceof StockError) return fail('conflict', error.message);
      throw error;
    }
  }

  /** What a returned delivery's line could have brought back, and whether this delivery issued its stock. */
  private couldBack(l: typeof deliveryLines.$inferSelect): ReturnableLine {
    const issuedHere = Number(l.issued) > 0;
    return { could: Number(issuedHere ? l.issued : (l.picked ?? l.quantity)), issuedHere };
  }

  /** Does one line of a receipt to stock, once for `key`, and says what it did. */
  private async applyLine(tx: Tx, actor: DocActor, row: typeof deliveries.$inferSelect, line: { productId: string; quantity: number; disposition: ReturnDisposition }, key: string, issuedHere: boolean) {
    if (line.quantity <= 0 || line.disposition === 'keep') return { locationId: null, effects: {} as ReturnEffects };
    return await this.stock.receiveGoodsBackIn(tx, { companyId: actor.companyId, orderId: row.orderId, productId: line.productId, quantity: line.quantity, key, disposition: line.disposition, issuedHere, actor: actor.userId, note: `${row.number} returned: ${DISPOSITION_WORDS[line.disposition].name}` });
  }

  private async receiveReturnIn(actor: DocActor, id: string, lines: { productId: string; quantity: number; disposition: string }[], note: string | null): Promise<DocResult<DeliveryView>> {
    return await this.db.transaction(async (tx): Promise<DocResult<DeliveryView>> => {
      const [row] = await tx.select().from(deliveries).where(and(eq(deliveries.id, id), eq(deliveries.companyId, actor.companyId))).for('update');
      if (row === undefined) return fail('not_found', 'That delivery could not be found.');
      if (row.status !== 'returned') return fail('not_allowed', 'Only a delivery that has been returned has goods to receive.');
      const moment = await this.momentIn(tx, actor.companyId);
      const [have, done] = await Promise.all([tx.select().from(deliveryLines).where(eq(deliveryLines.deliveryId, id)), tx.select({ productId: deliveryReturns.productId }).from(deliveryReturns).where(eq(deliveryReturns.deliveryId, id))]);
      const received = new Set(done.map((d) => d.productId));
      if (lines.some((l) => received.has(l.productId))) return fail('conflict', 'That product has already been received for this delivery. To change it, correct the receipt.');
      const back = new Map<string, ReturnableLine>(have.map((l) => [l.productId, this.couldBack(l)]));
      const problem = returnProblem(moment, back, lines);
      if (problem !== null) return fail('bad_input', problem);

      let returned = 0;
      const detail: Record<string, unknown>[] = [];
      for (const l of lines) {
        const disposition = l.disposition as ReturnDisposition;
        const done1 = await this.applyLine(tx, actor, row, { ...l, disposition }, `${id}:r1`, back.get(l.productId)?.issuedHere === true);
        await tx.insert(deliveryReturns).values({ companyId: actor.companyId, deliveryId: id, productId: l.productId, quantity: String(l.quantity), disposition, locationId: done1.locationId, note, receivedBy: actor.userId, effects: done1.effects });
        if (disposition === 'return_to_stock') returned += l.quantity;
        detail.push({ productId: l.productId, quantity: l.quantity, disposition });
      }
      await tx.update(deliveries).set({ version: row.version + 1, updatedAt: new Date() }).where(eq(deliveries.id, id));
      await this.event(tx, id, 'receive_return', actor, row.status, row.status, { note, detail: { lines: detail } });
      await this.returnedStage(tx, actor, row, returned);
      if (detail.some((d) => d.disposition === 'scrap' || d.disposition === 'quarantine')) {
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id }, action: 'delivery.return_set_aside', actor: { type: 'user', id: actor.userId }, from: row.status, to: row.status, reason: { text: note ?? 'Goods came back and were set aside.' } }, tx);
      }
      return { ok: true, data: await this.viewIn(tx, actor.companyId, id) };
    });
  }

  private async returnedStage(tx: Tx, actor: DocActor, row: typeof deliveries.$inferSelect, returned: number): Promise<void> {
    if (returned <= 0) return;
    await OrderStages.moveIn(tx, row.orderId, 'returned_to_stock', 'succeeded', {
      actor: { type: 'user', id: actor.userId },
      ref: { type: 'delivery_stage', id: `${row.id}:returned_to_stock:${String(row.version)}` },
      message: `${row.number} · goods counted back into stock`,
      detail: { delivery: row.number, returned },
    });
  }

  /**
   * Corrects one product's receipt: what it did to stock is undone and the corrected receipt is done, in one transaction, as a new
   * revision with its reason; the earlier receipt stays on record. Refused once the goods have gone out again, because then putting the
   * receipt right would change what was shipped; a stock adjustment puts that right.
   */
  async correctReturn(actor: DocActor, id: string, input: { productId?: unknown; quantity?: unknown; disposition?: unknown; reason?: unknown }): Promise<DocResult<DeliveryView>> {
    const reason = text(input.reason, 300);
    if (reason === null || reason.length < 5) return fail('bad_input', 'Say why the receipt is being corrected, in a few words.');
    const line = { productId: typeof input.productId === 'string' ? input.productId : '', quantity: typeof input.quantity === 'number' ? input.quantity : Number.NaN, disposition: typeof input.disposition === 'string' ? input.disposition : '' };
    try {
      return await this.db.transaction(async (tx): Promise<DocResult<DeliveryView>> => {
        const [row] = await tx.select().from(deliveries).where(and(eq(deliveries.id, id), eq(deliveries.companyId, actor.companyId))).for('update');
        if (row === undefined) return fail('not_found', 'That delivery could not be found.');
        if (row.status !== 'returned') return fail('not_allowed', 'Only a delivery that has been returned has a receipt.');
        const [current] = await tx.select().from(deliveryReturns).where(and(eq(deliveryReturns.deliveryId, id), eq(deliveryReturns.productId, line.productId))).orderBy(desc(deliveryReturns.revision)).limit(1);
        if (current === undefined) return fail('not_found', 'That product has not been received yet. Receive it first.');
        const have = await tx.select().from(deliveryLines).where(eq(deliveryLines.deliveryId, id));
        const back = new Map<string, ReturnableLine>(have.map((l) => [l.productId, this.couldBack(l)]));
        const problem = returnProblem(await this.momentIn(tx, actor.companyId), back, [line]);
        if (problem !== null) return fail('bad_input', problem);
        const disposition = line.disposition as ReturnDisposition;
        const revision = current.revision + 1;
        const key = `${id}:r${String(revision)}`;
        await this.stock.undoReceiptIn(tx, { companyId: actor.companyId, orderId: row.orderId, productId: line.productId, key, actor: actor.userId, effects: current.effects });
        const done = await this.applyLine(tx, actor, row, { ...line, disposition }, key, back.get(line.productId)?.issuedHere === true);
        await tx.insert(deliveryReturns).values({ companyId: actor.companyId, deliveryId: id, productId: line.productId, quantity: String(line.quantity), disposition, locationId: done.locationId, note: current.note, receivedBy: actor.userId, revision, correctionReason: reason, effects: done.effects });
        await tx.update(deliveries).set({ version: row.version + 1, updatedAt: new Date() }).where(eq(deliveries.id, id));
        await this.event(tx, id, 'correct_return', actor, row.status, row.status, { note: reason, detail: { productId: line.productId, revision, from: { quantity: Number(current.quantity), disposition: current.disposition }, to: { quantity: line.quantity, disposition } } });
        await this.returnedStage(tx, actor, row, disposition === 'return_to_stock' ? line.quantity : 0);
        await this.decisions.record({ companyId: actor.companyId, subject: { type: 'delivery', id }, action: 'delivery.return_corrected', actor: { type: 'user', id: actor.userId }, from: current.disposition, to: disposition, reason: { text: reason } }, tx);
        return { ok: true, data: await this.viewIn(tx, actor.companyId, id) };
      });
    } catch (error) {
      if (error instanceof StockError) return fail('conflict', error.message);
      throw error;
    }
  }

  /** Writes something that happened to a delivery that does not change its state (news from a courier): one more line of its history and a new version. */
  async recordNote(tx: Tx, actor: DocActor, id: string, action: 'courier_update', note: string | null, detail: Record<string, unknown>): Promise<void> {
    const [row] = await tx.select({ status: deliveries.status, version: deliveries.version }).from(deliveries).where(and(eq(deliveries.id, id), eq(deliveries.companyId, actor.companyId)));
    if (row === undefined) return;
    await tx.update(deliveries).set({ version: row.version + 1, updatedAt: new Date() }).where(eq(deliveries.id, id));
    await this.event(tx, id, action, actor, row.status, row.status, { note, detail });
  }

  private async event(tx: Tx, deliveryId: string, action: string, actor: DocActor, from: string | null, to: string | null, extra: { reasonCode?: string | null; note?: string | null; detail?: Record<string, unknown> } = {}): Promise<void> {
    const [last] = await tx.select({ seq: sql<number>`COALESCE(MAX(${deliveryEvents.sequence}), 0)` }).from(deliveryEvents).where(eq(deliveryEvents.deliveryId, deliveryId));
    await tx.insert(deliveryEvents).values({ deliveryId, sequence: (last?.seq ?? 0) + 1, action, fromStatus: from, toStatus: to, actorType: 'user', actorId: actor.userId, reasonCode: extra.reasonCode ?? null, note: extra.note ?? null, detail: extra.detail ?? {} });
  }

  // ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────────

  private async committedIn(tx: Tx | DrizzleDb, orderId: string): Promise<QuantityLine[]> {
    const rows = await tx
      .select({ productId: deliveryLines.productId, quantity: deliveryLines.quantity, picked: deliveryLines.picked, status: deliveries.status })
      .from(deliveryLines)
      .innerJoin(deliveries, eq(deliveries.id, deliveryLines.deliveryId))
      .where(eq(deliveries.orderId, orderId));
    return rows.filter((r) => isLive(r.status)).map((r) => ({ productId: r.productId, quantity: Number(r.picked ?? r.quantity) }));
  }

  /** The facts of every delivery of an order, with the given ones replaced (what it would be after a change being made). */
  private async factsIn(tx: Tx | DrizzleDb, orderId: string, replace = new Map<string, DeliveryFacts>()): Promise<DeliveryFacts[]> {
    const rows = await tx
      .select({ id: deliveries.id, status: deliveries.status, productId: deliveryLines.productId, quantity: deliveryLines.quantity, picked: deliveryLines.picked, delivered: deliveryLines.delivered })
      .from(deliveries)
      .innerJoin(deliveryLines, eq(deliveryLines.deliveryId, deliveries.id))
      .where(eq(deliveries.orderId, orderId));
    const byId = new Map<string, DeliveryFacts & { lines: DeliveryFacts['lines'][number][] }>();
    for (const r of rows) {
      const facts = byId.get(r.id) ?? { status: r.status, lines: [] };
      facts.lines.push({ productId: r.productId, quantity: Number(r.quantity), picked: r.picked === null ? null : Number(r.picked), delivered: Number(r.delivered) });
      byId.set(r.id, facts);
    }
    return [...byId].map(([id, facts]) => replace.get(id) ?? facts);
  }

  private async decimalsOf(tx: Tx | DrizzleDb, productIds: string[]): Promise<Map<string, { decimals: number; name: string }>> {
    if (productIds.length === 0) return new Map();
    const rows = await tx
      .select({ id: products.id, decimals: unitsOfMeasure.decimals, name: unitsOfMeasure.name })
      .from(products)
      .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.baseUnitId))
      .where(inArray(products.id, productIds));
    return new Map(rows.map((r) => [r.id, { decimals: r.decimals ?? 3, name: r.name ?? 'its unit' }]));
  }

  /** The stored photo of a proof, only if the proof belongs to this company. The caller turns it into a short-lived link after its own permission check. */
  async proofPhoto(companyId: string, proofId: string): Promise<string | null> {
    const [row] = await this.db
      .select({ mediaId: deliveryProofs.mediaId })
      .from(deliveryProofs)
      .innerJoin(deliveryAttempts, eq(deliveryAttempts.id, deliveryProofs.attemptId))
      .where(and(eq(deliveryProofs.id, proofId), eq(deliveryAttempts.companyId, companyId)));
    return row?.mediaId ?? null;
  }

  async get(companyId: string, id: string): Promise<DeliveryView | null> {
    return await this.viewIn(this.db, companyId, id, true);
  }

  private async viewIn(db: Tx | DrizzleDb, companyId: string, id: string): Promise<DeliveryView>;
  private async viewIn(db: Tx | DrizzleDb, companyId: string, id: string, nullable: true): Promise<DeliveryView | null>;
  private async viewIn(db: Tx | DrizzleDb, companyId: string, id: string, nullable = false): Promise<DeliveryView | null> {
    const [row] = await db
      .select({ d: deliveries, orderNumber: orders.orderNumber, customerName: orders.customerName, branchName: branches.name })
      .from(deliveries)
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .innerJoin(branches, eq(branches.id, deliveries.branchId))
      .where(and(eq(deliveries.id, id), eq(deliveries.companyId, companyId)));
    if (row === undefined) {
      if (nullable) return null;
      throw new Error(`The delivery ${id} vanished while it was locked.`);
    }
    const returned = row.d.status === 'returned';
    const [receipts, moment] = returned ? await Promise.all([db.select().from(deliveryReturns).where(eq(deliveryReturns.deliveryId, id)).orderBy(asc(deliveryReturns.revision)), this.momentIn(db as Tx, companyId)]) : [[], 'payment' as IssueMoment];
    // A receipt can be corrected while the holds it made are still untouched: one read of them all.
    const holdIds = receipts.flatMap((r) => r.effects.holds ?? []);
    const used = new Set(holdIds.length === 0 ? [] : (await db.select({ id: stockReservations.id, state: stockReservations.state, consumed: stockReservations.consumed, released: stockReservations.released }).from(stockReservations).where(inArray(stockReservations.id, holdIds))).filter((h) => h.state !== 'held' || h.consumed > 0 || h.released > 0).map((h) => h.id));
    const [lines, events, attemptRows] = await Promise.all([
      db
        .select({ id: deliveryLines.id, productId: deliveryLines.productId, productName: products.name, sku: products.sku, quantity: deliveryLines.quantity, picked: deliveryLines.picked, delivered: deliveryLines.delivered, issued: deliveryLines.issued })
        .from(deliveryLines)
        .innerJoin(products, eq(products.id, deliveryLines.productId))
        .where(eq(deliveryLines.deliveryId, id))
        .orderBy(asc(products.name), asc(deliveryLines.id)),
      db.select().from(deliveryEvents).where(eq(deliveryEvents.deliveryId, id)).orderBy(asc(deliveryEvents.sequence)),
      db
        .select({ a: deliveryAttempts, riderName: deliveryRiders.name })
        .from(deliveryAttempts)
        .innerJoin(deliveryRiders, eq(deliveryRiders.id, deliveryAttempts.riderId))
        .where(eq(deliveryAttempts.deliveryId, id))
        .orderBy(asc(deliveryAttempts.attemptNo)),
    ]);
    const proofRows = attemptRows.length === 0 ? [] : await db.select({ id: deliveryProofs.id, attemptId: deliveryProofs.attemptId, kind: deliveryProofs.kind }).from(deliveryProofs).where(inArray(deliveryProofs.attemptId, attemptRows.map((r) => r.a.id))).orderBy(asc(deliveryProofs.createdAt));
    const d = row.d;
    return {
      id: d.id,
      number: d.number,
      orderId: d.orderId,
      orderNumber: row.orderNumber,
      customerName: row.customerName,
      method: d.method,
      status: d.status,
      statusWords: STATUS_WORDS[d.status],
      branch: { id: d.branchId, name: row.branchName },
      destination: d.destination,
      recipientName: d.recipientName,
      recipientPhone: d.recipientPhone,
      notes: d.notes,
      courierName: d.courierName,
      trackingNumber: d.trackingNumber,
      receivedBy: d.receivedBy,
      failedAttempts: d.failedAttempts,
      hasCode: d.handoverCode !== null,
      version: d.version,
      createdAt: d.createdAt.toISOString(),
      releasedAt: d.releasedAt?.toISOString() ?? null,
      dispatchedAt: d.dispatchedAt?.toISOString() ?? null,
      deliveredAt: d.deliveredAt?.toISOString() ?? null,
      lines: lines.map((l) => {
        const issuedHere = Number(l.issued) > 0;
        const mine = receipts.filter((r) => r.productId === l.productId);
        const receipt = mine[mine.length - 1];
        const disposition = receipt?.disposition as ReturnDisposition | undefined;
        const words = (d: string): string => DISPOSITION_WORDS[d as ReturnDisposition].name;
        return {
          id: l.id,
          productId: l.productId,
          productName: l.productName,
          sku: l.sku,
          quantity: num(l.quantity),
          picked: l.picked === null ? null : Number(l.picked),
          delivered: num(l.delivered),
          issued: num(l.issued),
          back: !returned
            ? null
            : {
                could: issuedHere ? num(l.issued) : Number(l.picked ?? l.quantity),
                choices: receipt === undefined ? dispositionsFor(moment, issuedHere).map((d) => ({ id: d, ...DISPOSITION_WORDS[d] })) : [],
                receipt: receipt === undefined || disposition === undefined ? null : { quantity: Number(receipt.quantity), disposition, words: words(disposition), receivedAt: receipt.receivedAt.toISOString(), revision: receipt.revision, correctionReason: receipt.correctionReason, correctable: !(receipt.effects.holds ?? []).some((h) => used.has(h)) },
                earlier: mine.slice(0, -1).map((r) => ({ revision: r.revision, quantity: Number(r.quantity), words: words(r.disposition), receivedAt: r.receivedAt.toISOString(), correctionReason: r.correctionReason })),
                correctTo: receipt === undefined ? [] : dispositionsFor(moment, issuedHere).map((d) => ({ id: d, ...DISPOSITION_WORDS[d] })),
              },
        };
      }),
      events: events.map((e) => ({
        sequence: e.sequence,
        action: e.action,
        actionWords: eventWords(e.action),
        fromStatus: e.fromStatus,
        toStatus: e.toStatus,
        actorId: e.actorId,
        reasonCode: e.reasonCode,
        note: e.note,
        detail: e.detail,
        occurredAt: e.occurredAt.toISOString(),
      })),
      attempts: attemptRows.map(({ a, riderName }) => ({
        attemptNo: a.attemptNo,
        result: a.result,
        resultWords: a.result === 'delivered' ? 'Delivered' : (FAILURE_REASONS.find((r) => r.code === a.result)?.words ?? a.result),
        riderName,
        receivedBy: a.receivedBy,
        note: a.note,
        place: a.latitude === null || a.longitude === null ? null : { lat: a.latitude, lng: a.longitude },
        occurredAt: a.occurredAt.toISOString(),
        clientTime: a.clientTime?.toISOString() ?? null,
        proofs: proofRows.filter((p) => p.attemptId === a.id).map((p) => ({ id: p.id, kind: p.kind })),
      })),
      actions: actionsFrom(d.status).map((action) => ({ action, words: ACTION_WORDS[action] })),
    };
  }

  /** One page of deliveries, newest first, by state or by what is typed (a delivery or order number, or the customer's name). */
  async list(companyId: string, input: { status?: unknown; query?: unknown; cursor?: unknown }): Promise<{ rows: DeliveryListItem[]; nextCursor: string | null }> {
    const status = typeof input.status === 'string' && input.status !== '' ? input.status : null;
    const query = typeof input.query === 'string' ? input.query.trim().slice(0, 100) : '';
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const pattern = `%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    const rows = await this.db
      .select({
        d: deliveries,
        orderNumber: orders.orderNumber,
        customerName: orders.customerName,
        branchName: branches.name,
        lineCount: sql<number>`(SELECT count(*)::int FROM delivery_lines l WHERE l.delivery_id = ${deliveries.id})`,
        cursorKey: sql<string>`${deliveries.createdAt}::text`,
      })
      .from(deliveries)
      .innerJoin(orders, eq(orders.id, deliveries.orderId))
      .innerJoin(branches, eq(branches.id, deliveries.branchId))
      .where(
        and(
          eq(deliveries.companyId, companyId),
          status === null ? undefined : eq(deliveries.status, status as DeliveryStatus),
          query === '' ? undefined : sql`(${deliveries.number} ILIKE ${pattern} OR ${orders.orderNumber} ILIKE ${pattern} OR ${orders.customerName} ILIKE ${pattern})`,
          after === null ? undefined : sql`(${deliveries.createdAt}, ${deliveries.id}) < (${after.k}::timestamptz, ${after.id}::uuid)`,
        ),
      )
      .orderBy(desc(deliveries.createdAt), desc(deliveries.id))
      .limit(PAGE + 1);
    const page = rows.slice(0, PAGE);
    const last = page.at(-1);
    return {
      rows: page.map((r) => ({ id: r.d.id, number: r.d.number, orderNumber: r.orderNumber, customerName: r.customerName, method: r.d.method, status: r.d.status, statusWords: STATUS_WORDS[r.d.status], branchName: r.branchName, lineCount: r.lineCount, createdAt: r.d.createdAt.toISOString() })),
      nextCursor: rows.length > PAGE && last !== undefined ? encodeCursor({ k: last.cursorKey, id: last.d.id }) : null,
    };
  }

  /** An order's deliveries and what it has left, for its own screen. Null when there is no such order. */
  async forOrder(companyId: string, orderId: string): Promise<OrderDeliveries | null> {
    const [order] = await this.db.select({ id: orders.id, status: orders.status, paymentStatus: orders.paymentStatus, approvalStatus: orders.approvalStatus, paymentMethod: orders.paymentMethod }).from(orders).where(eq(orders.id, orderId));
    if (order === undefined) return null;
    const [chosen] = await this.db.select({ method: orderDeliveries.method }).from(orderDeliveries).where(and(eq(orderDeliveries.orderId, orderId), eq(orderDeliveries.companyId, companyId)));
    const ordered = await this.db
      .select({ productId: orderItems.productId, quantity: orderItems.quantity, name: orderItems.productName, sku: orderItems.sku })
      .from(orderItems)
      .where(eq(orderItems.orderId, orderId));
    const facts = await this.factsIn(this.db, orderId);
    const status = orderDeliveryStatus(ordered.map((o) => ({ productId: o.productId, quantity: o.quantity })), facts);
    const names = new Map(ordered.map((o) => [o.productId, { name: o.name, sku: o.sku }]));
    const decimals = await this.decimalsOf(this.db, [...names.keys()]);
    const list = await this.db
      .select({ id: deliveries.id, number: deliveries.number, status: deliveries.status, lineCount: sql<number>`(SELECT count(*)::int FROM delivery_lines l WHERE l.delivery_id = ${deliveries.id})` })
      .from(deliveries)
      .where(and(eq(deliveries.orderId, orderId), eq(deliveries.companyId, companyId)))
      .orderBy(asc(deliveries.createdAt));
    let eligible: OrderDeliveries['eligible'] = { ok: true };
    if (chosen === undefined) eligible = { ok: false, reason: 'This order has no delivery.' };
    else if (!isDocumentMethod(chosen.method)) eligible = { ok: false, reason: chosen.method === 'pickup' ? 'This order is collected from a branch.' : 'This kind of delivery is not made here yet.' };
    else if (orderReadinessProblem(order)?.reason === 'order_closed') eligible = { ok: false, reason: 'This order was cancelled or refunded.' };
    return {
      state: status.state,
      lines: status.lines.map((l) => ({ ...l, productName: names.get(l.productId)?.name ?? l.productId, sku: names.get(l.productId)?.sku ?? '', decimals: decimals.get(l.productId)?.decimals ?? 3 })),
      deliveries: list.map((d) => ({ id: d.id, number: d.number, status: d.status, statusWords: STATUS_WORDS[d.status], lineCount: d.lineCount })),
      eligible,
    };
  }
}

interface StepContext {
  row: typeof deliveries.$inferSelect;
  lines: (typeof deliveryLines.$inferSelect)[];
  order: { id: string; status: string; paymentStatus: string; approvalStatus: string | null; paymentMethod: string; orderNumber: string };
  afterDelivery: () => Promise<'delivered' | 'part_delivered'>;
}

interface StepOutcome {
  set: Partial<typeof deliveries.$inferInsert>;
  /** Column changes that depend on the row's own value (a counter going up). */
  bump?: Record<string, unknown>;
  reasonCode?: string | null;
  note?: string | null;
  detail?: Record<string, unknown>;
  stageDetail?: Record<string, unknown>;
  /** The reason recorded on the order's timeline for a failure. */
  stageReason?: string;
}

