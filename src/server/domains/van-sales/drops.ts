import { and, asc, eq, inArray } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customers, orderDeliveries, orderItems, orders, products, stockReservations, vanDays, vanDrops, vanVisits, vans } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { OrderDeliveries } from '@/server/domains/delivery/order-delivery';
import type { DeliveryDocuments } from '@/server/domains/delivery/documents';
import type { StockReservations } from '@/server/domains/stock/reservations';
import type { SalesChannel } from '@/lib/stock';
import { DROP_STATE_WORDS, DROP_STOCK_WORDS, deliverProblem, dropAddProblem, dropNeeds, dropRemovable, readDropState, readDropStock, readReceivedBy, type CloseState, type DropState, type DropStock } from '@/lib/van-sales/drops';
import { readWhy } from '@/lib/van-sales/run';
import { isId } from '@/lib/van-sales/people';
import { recordDayEvent } from './day-events';
import { VanSalesError } from './errors';
import { ownDay } from './own-day';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface DropLineView {
  productId: string;
  name: string;
  quantity: number;
}

export interface DropView {
  id: string;
  orderId: string;
  orderNumber: string;
  customerName: string;
  visitId: string;
  total: number;
  state: DropState;
  stateWords: string;
  stock: DropStock;
  stockWords: string;
  reason: string | null;
  lines: DropLineView[];
  removable: boolean;
}

const text = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim());

/**
 * Pre-sold orders delivered from the van on a van day (docs/architecture/van-sales.md §4.6). Planning (add, take off) and where the order's stock is:
 * at the warehouse until the load that carries it leaves, on its way with the load, then held on the van for the order. A load can only be shipped
 * when the shelves are free of it, so the hold is set aside at the moment of shipping and made again on the van when the rep signs.
 */
export class VanDropService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly orderDeliveries: OrderDeliveries,
    private readonly reservations: StockReservations,
    private readonly documents: DeliveryDocuments,
  ) {}

  /** The day's deliveries, with the lines and where the stock is. */
  async forDay(companyId: string, dayId: string): Promise<DropView[]> {
    if (!isId(dayId)) return [];
    const rows = await this.db
      .select({ d: vanDrops, number: orders.orderNumber, customer: orders.customerName, total: orders.totalAmount })
      .from(vanDrops)
      .innerJoin(orders, eq(orders.id, vanDrops.orderId))
      .where(and(eq(vanDrops.companyId, companyId), eq(vanDrops.dayId, dayId)))
      .orderBy(asc(vanDrops.createdAt), asc(vanDrops.id))
      .limit(200);
    if (rows.length === 0) return [];
    const lines = await this.db
      .select({ orderId: orderItems.orderId, productId: orderItems.productId, name: products.name, quantity: orderItems.quantity })
      .from(orderItems)
      .innerJoin(products, eq(products.id, orderItems.productId))
      .where(inArray(orderItems.orderId, rows.map((r) => r.d.orderId)))
      .orderBy(asc(orderItems.lineNo));
    return rows.map((r) => {
      const state = readDropState(r.d.state);
      const stock = readDropStock(r.d.stockState);
      return {
        id: r.d.id,
        orderId: r.d.orderId,
        orderNumber: r.number,
        customerName: r.customer,
        visitId: r.d.visitId,
        total: Number(r.total),
        state,
        stateWords: DROP_STATE_WORDS[state],
        stock,
        stockWords: DROP_STOCK_WORDS[stock],
        reason: r.d.reason,
        lines: lines.filter((l) => l.orderId === r.d.orderId).map((l) => ({ productId: l.productId, name: l.name, quantity: l.quantity })),
        removable: dropRemovable(state, stock),
      };
    });
  }

  /** What the deliveries still at the warehouse need put on the van, per product (for the load planner). */
  async needs(companyId: string, dayId: string): Promise<Map<string, number>> {
    if (!isId(dayId)) return new Map();
    const rows = await this.db
      .select({ productId: orderItems.productId, quantity: orderItems.quantity })
      .from(vanDrops)
      .innerJoin(orderItems, eq(orderItems.orderId, vanDrops.orderId))
      .where(and(eq(vanDrops.companyId, companyId), eq(vanDrops.dayId, dayId), eq(vanDrops.state, 'planned'), eq(vanDrops.stockState, 'at_warehouse')));
    return dropNeeds(rows);
  }

  /** Adds an order to the day's deliveries: its delivery is planned from the order's branch if it has none, and its stock is counted in the load. */
  async add(companyId: string, actor: Actor, dayId: string, orderId: string): Promise<void> {
    if (!isId(dayId)) throw new VanSalesError('That day could not be found.');
    if (typeof orderId !== 'string' || orderId.trim() === '' || orderId.length > 100) throw new VanSalesError('Choose the order to deliver.');
    const facts = await this.factsOf(this.db, companyId, dayId, orderId);
    const problem = dropAddProblem(facts.facts);
    if (problem !== null) throw new VanSalesError(problem);
    if (facts.visit === undefined) throw new VanSalesError('The customer is not on this day\'s visits.');
    if (facts.facts.order.deliveryMethod === null) {
      const a = facts.address;
      const planned = await this.orderDeliveries.planStaffOrder({ companyId, userId: actor.id ?? 'system' }, orderId, { method: 'own_fleet', county: a.county, town: a.town, area: a.area });
      if (!planned.ok) throw new VanSalesError(planned.message);
    }
    const visitId = facts.visit.id;
    await this.db.transaction(async (tx) => {
      const made = await tx.insert(vanDrops).values({ companyId, dayId, visitId, orderId, createdBy: actor.id ?? 'system' }).onConflictDoNothing().returning({ id: vanDrops.id });
      if (made.length === 0) throw new VanSalesError(`${facts.facts.order.number} is already on a delivery.`);
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.drop_added', { detail: { order: facts.facts.order.number, customer: facts.customerName } });
    });
  }

  /** Takes a delivery off the day, while its stock has not left the warehouse. */
  async remove(companyId: string, actor: Actor, dayId: string, dropId: string): Promise<void> {
    if (!isId(dayId) || !isId(dropId)) throw new VanSalesError('That delivery could not be found.');
    await this.db.transaction(async (tx) => {
      const [row] = await tx.select({ d: vanDrops, number: orders.orderNumber }).from(vanDrops).innerJoin(orders, eq(orders.id, vanDrops.orderId)).where(and(eq(vanDrops.id, dropId), eq(vanDrops.dayId, dayId), eq(vanDrops.companyId, companyId))).for('update');
      if (row === undefined) throw new VanSalesError('That delivery could not be found.');
      if (!dropRemovable(readDropState(row.d.state), readDropStock(row.d.stockState))) throw new VanSalesError(`${row.number} has already been loaded or dealt with, so it stays on the day.`);
      await tx.delete(vanDrops).where(eq(vanDrops.id, dropId));
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.drop_removed', { detail: { order: row.number } });
    });
  }

  // ── Delivering at the visit (the rep's own) ──────────────────────────

  private async dropAt(companyId: string, dayId: string, dropId: string) {
    if (!isId(dropId)) throw new VanSalesError('That delivery could not be found.');
    const [row] = await this.db
      .select({ d: vanDrops, number: orders.orderNumber, customer: orders.customerName, visitStatus: vanVisits.status, dayStatus: vanDays.status })
      .from(vanDrops)
      .innerJoin(orders, eq(orders.id, vanDrops.orderId))
      .innerJoin(vanVisits, eq(vanVisits.id, vanDrops.visitId))
      .innerJoin(vanDays, eq(vanDays.id, vanDrops.dayId))
      .where(and(eq(vanDrops.id, dropId), eq(vanDrops.dayId, dayId), eq(vanDrops.companyId, companyId)))
      .limit(1);
    if (row === undefined) throw new VanSalesError('That delivery could not be found on this day.');
    return row;
  }

  /**
   * Delivers the order to the customer the rep is standing at, from the van's own stock. It is an ordinary delivery document, taken through its
   * steps in one go (a step that was done is not done again, so a retry carries on from where it stopped). A refusal at the door, such as an order
   * not paid for, leaves the delivery where it got to and says why.
   */
  async deliver(companyId: string, actor: Actor, dayId: string, dropId: string, raw: unknown, maySell: boolean): Promise<void> {
    await ownDay(this.db, companyId, actor, dayId, maySell);
    const received = readReceivedBy((typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}).receivedBy);
    if (!received.ok) throw new VanSalesError(received.error);
    const row = await this.dropAt(companyId, dayId, dropId);
    const problem = deliverProblem({ dayStatus: row.dayStatus, visitStatus: row.visitStatus, state: readDropState(row.d.state), stock: readDropStock(row.d.stockState), customerName: row.customer, orderNumber: row.number });
    if (problem !== null) throw new VanSalesError(problem);
    const who = { companyId, userId: actor.id ?? 'system' };
    let deliveryId = row.d.deliveryId;
    if (deliveryId === null) {
      const made = await this.documents.create(who, row.d.orderId, { lines: null });
      if (!made.ok) throw new VanSalesError(made.message);
      deliveryId = made.data.id;
      await this.db.update(vanDrops).set({ deliveryId, updatedAt: new Date() }).where(eq(vanDrops.id, dropId));
    }
    for (let guard = 0; guard < 10; guard += 1) {
      const view = await this.documents.get(companyId, deliveryId);
      if (view === null) throw new VanSalesError('The delivery could not be found.');
      if (view.status === 'delivered') break;
      const result = await this.nextStep(who, view, received.name);
      if (!result.ok) throw new VanSalesError(result.message);
    }
    await this.db.transaction(async (tx) => {
      const done = await tx.update(vanDrops).set({ state: 'delivered', version: row.d.version + 1, updatedAt: new Date() }).where(and(eq(vanDrops.id, dropId), eq(vanDrops.state, 'planned'))).returning({ id: vanDrops.id });
      if (done.length === 0) return;
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.drop_delivered', { detail: { order: row.number, customer: row.customer, receivedBy: received.name } });
    });
  }

  private async nextStep(who: { companyId: string; userId: string }, view: NonNullable<Awaited<ReturnType<DeliveryDocuments['get']>>>, receivedBy: string) {
    const v = view.version;
    switch (view.status) {
      case 'draft': return await this.documents.release(who, view.id, v);
      case 'released': return await this.documents.startPicking(who, view.id, v);
      case 'picking':
        if (view.lines.some((l) => l.picked === null)) return await this.documents.recordPicked(who, view.id, { picked: view.lines.map((l) => ({ productId: l.productId, quantity: l.quantity })) }, v);
        return await this.documents.markPacked(who, view.id, v);
      case 'packed': return await this.documents.markReady(who, view.id, v);
      case 'ready': return await this.documents.dispatch(who, view.id, {}, v);
      case 'out_for_delivery': return await this.documents.deliver(who, view.id, { receivedBy }, v);
      case 'delivered':
      case 'failed_attempt':
      case 'returned':
      case 'cancelled': return { ok: false as const, reason: 'not_allowed' as const, message: `The delivery is ${view.statusWords.toLowerCase()}, so it cannot be taken further here.` };
    }
  }

  /** The customer refused the goods, or they could not be delivered: the delivery is closed with the reason. The stock stays held on the van until it is unloaded. */
  async close(companyId: string, actor: Actor, dayId: string, dropId: string, state: CloseState, reason: unknown, maySell: boolean): Promise<void> {
    await ownDay(this.db, companyId, actor, dayId, maySell);
    const why = readWhy(reason);
    if (!why.ok) throw new VanSalesError(why.error);
    const row = await this.dropAt(companyId, dayId, dropId);
    const problem = deliverProblem({ dayStatus: row.dayStatus, visitStatus: row.visitStatus, state: readDropState(row.d.state), stock: readDropStock(row.d.stockState), customerName: row.customer, orderNumber: row.number }, false);
    if (problem !== null) throw new VanSalesError(problem);
    await this.db.transaction(async (tx) => {
      const done = await tx.update(vanDrops).set({ state, reason: why.reason, version: row.d.version + 1, updatedAt: new Date() }).where(and(eq(vanDrops.id, dropId), eq(vanDrops.state, 'planned'))).returning({ id: vanDrops.id });
      if (done.length === 0) return;
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, state === 'refused' ? 'day.drop_refused' : 'day.drop_failed', { reason: why.reason, detail: { order: row.number, customer: row.customer } });
    });
  }

  // ── The stock, with the load ─────────────────────────────────────────

  /**
   * Called just before a load is shipped with `shipped` (per product): every delivery still at the warehouse whose whole order the load covers has
   * its hold set aside, so the shelves are free for the transfer, and is marked on its way. Returns those it moved, to put back if the ship fails.
   */
  async setAsideForLoad(companyId: string, actor: Actor, dayId: string, shipped: ReadonlyMap<string, number>): Promise<string[]> {
    return await this.db.transaction(async (tx) => {
      const drops = await tx.select({ d: vanDrops, number: orders.orderNumber }).from(vanDrops).innerJoin(orders, eq(orders.id, vanDrops.orderId)).where(and(eq(vanDrops.companyId, companyId), eq(vanDrops.dayId, dayId), eq(vanDrops.state, 'planned'), eq(vanDrops.stockState, 'at_warehouse'))).orderBy(asc(vanDrops.createdAt)).for('update');
      const left = new Map(shipped);
      const moved: string[] = [];
      for (const drop of drops) {
        const lines = await tx.select({ productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, drop.d.orderId));
        const need = dropNeeds(lines);
        if (![...need].every(([p, q]) => (left.get(p) ?? 0) >= q)) continue;
        for (const [p, q] of need) left.set(p, (left.get(p) ?? 0) - q);
        const held = await this.reservations.setAsideIn(tx, { companyId, refType: 'order', refId: drop.d.orderId, actor: actor.id ?? 'system', reason: `Loaded onto the van for ${drop.number}` });
        await tx.update(vanDrops).set({ stockState: 'on_the_way', holdChannel: held.channel, version: drop.d.version + 1, updatedAt: new Date() }).where(eq(vanDrops.id, drop.d.id));
        await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.drop_on_the_way', { detail: { order: drop.number } });
        moved.push(drop.d.id);
      }
      return moved;
    });
  }

  /**
   * The van is being unloaded: the stock held on it for a delivery that was refused or could not be made is set aside, so the stock can leave, and
   * the delivery is marked on its way back. It is held again at the warehouse when the unload is received (`rehomeAfterUnload`).
   */
  async setAsideForUnload(companyId: string, actor: Actor, dayId: string): Promise<string[]> {
    return await this.db.transaction(async (tx) => {
      const drops = await tx.select({ d: vanDrops, number: orders.orderNumber }).from(vanDrops).innerJoin(orders, eq(orders.id, vanDrops.orderId)).where(and(eq(vanDrops.companyId, companyId), eq(vanDrops.dayId, dayId), inArray(vanDrops.state, ['refused', 'failed']), eq(vanDrops.stockState, 'on_van'))).orderBy(asc(vanDrops.createdAt)).for('update');
      const moved: string[] = [];
      for (const drop of drops) {
        const held = await this.reservations.setAsideIn(tx, { companyId, refType: 'order', refId: drop.d.orderId, actor: actor.id ?? 'system', reason: `Coming back from the van for ${drop.number}` });
        await tx.update(vanDrops).set({ stockState: 'on_the_way', holdChannel: held.channel ?? drop.d.holdChannel, version: drop.d.version + 1, updatedAt: new Date() }).where(eq(vanDrops.id, drop.d.id));
        await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.drop_on_the_way', { detail: { order: drop.number, coming: 'back' } });
        moved.push(drop.d.id);
      }
      return moved;
    });
  }

  /** The unload has been received at the warehouse: each of those deliveries is held at the warehouse again, or marked short if what came back does not cover it. */
  async rehomeAfterUnload(companyId: string, actor: Actor, dayId: string): Promise<void> {
    const ids = await this.db.select({ id: vanDrops.id }).from(vanDrops).where(and(eq(vanDrops.dayId, dayId), inArray(vanDrops.state, ['refused', 'failed']), eq(vanDrops.stockState, 'on_the_way')));
    await this.putBack(companyId, actor, dayId, ids.map((r) => r.id));
  }

  /** Deliveries on this day that are not dealt with yet: they stop the day coming back. */
  async open(companyId: string, dayId: string): Promise<string[]> {
    if (!isId(dayId)) return [];
    const rows = await this.db.select({ number: orders.orderNumber }).from(vanDrops).innerJoin(orders, eq(orders.id, vanDrops.orderId)).where(and(eq(vanDrops.companyId, companyId), eq(vanDrops.dayId, dayId), eq(vanDrops.state, 'planned'))).orderBy(asc(vanDrops.createdAt));
    return rows.map((r) => r.number);
  }

  /** The load did not ship: each of those deliveries has its hold made again at the warehouse. A hold that cannot be made again is said so, in the day's history. */
  async putBack(companyId: string, actor: Actor, dayId: string, dropIds: readonly string[]): Promise<void> {
    for (const id of dropIds) {
      await this.db.transaction(async (tx) => {
        const [row] = await tx.select({ d: vanDrops, number: orders.orderNumber, branchId: orders.branchId }).from(vanDrops).innerJoin(orders, eq(orders.id, vanDrops.orderId)).where(eq(vanDrops.id, id)).for('update');
        if (row?.d.stockState !== 'on_the_way') return;
        const lines = await tx.select({ productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, row.d.orderId));
        const result = await this.reservations.reserveIn(tx, { companyId, refType: 'order', refId: row.d.orderId, lines: [...dropNeeds(lines)].map(([productId, quantity]) => ({ productId, quantity })), channel: this.channelOf(row.d.holdChannel), branchId: row.branchId, actor: actor.id ?? 'system' });
        await tx.update(vanDrops).set({ stockState: result.ok ? 'at_warehouse' : 'short', version: row.d.version + 1, updatedAt: new Date() }).where(eq(vanDrops.id, id));
        await recordDayEvent(tx, this.decisions, companyId, dayId, actor, result.ok ? 'day.drop_put_back' : 'day.drop_short', { detail: { order: row.number, ...(result.ok ? {} : { problem: result.error }) } });
      });
    }
  }

  /** The rep has signed for the load: each delivery that was on its way is held on the van, or marked short if the van does not hold enough of it. */
  async holdOnVan(companyId: string, actor: Actor, dayId: string): Promise<void> {
    const [day] = await this.db.select({ location: vans.locationId }).from(vanDays).leftJoin(vans, eq(vans.id, vanDays.vanId)).where(eq(vanDays.id, dayId));
    const van = day?.location ?? null;
    if (van === null) return;
    const ids = await this.db.select({ id: vanDrops.id }).from(vanDrops).where(and(eq(vanDrops.dayId, dayId), eq(vanDrops.stockState, 'on_the_way')));
    for (const { id } of ids) {
      await this.db.transaction(async (tx) => {
        const [row] = await tx.select({ d: vanDrops, number: orders.orderNumber, branchId: orders.branchId }).from(vanDrops).innerJoin(orders, eq(orders.id, vanDrops.orderId)).where(eq(vanDrops.id, id)).for('update');
        if (row?.d.stockState !== 'on_the_way') return;
        const lines = await tx.select({ productId: orderItems.productId, quantity: orderItems.quantity }).from(orderItems).where(eq(orderItems.orderId, row.d.orderId));
        const result = await this.reservations.reserveIn(tx, { companyId, refType: 'order', refId: row.d.orderId, lines: [...dropNeeds(lines)].map(([productId, quantity]) => ({ productId, quantity })), channel: this.channelOf(row.d.holdChannel), fromLocationId: van, actor: actor.id ?? 'system' });
        await tx.update(vanDrops).set({ stockState: result.ok ? 'on_van' : 'short', version: row.d.version + 1, updatedAt: new Date() }).where(eq(vanDrops.id, id));
        await recordDayEvent(tx, this.decisions, companyId, dayId, actor, result.ok ? 'day.drop_on_van' : 'day.drop_short', { detail: { order: row.number, ...(result.ok ? {} : { problem: result.error }) } });
      });
    }
  }

  private channelOf(recorded: string | null): SalesChannel {
    return (recorded ?? 'ecommerce') as SalesChannel;
  }

  /** The facts the rules read: the day, the order, the customer's visit and the words of the customer's address. */
  private async factsOf(db: Pick<DrizzleDb, 'select'> | Tx, companyId: string, dayId: string, orderId: string) {
    const [day] = await db.select({ status: vanDays.status, mode: vanDays.mode, vanId: vanDays.vanId }).from(vanDays).where(and(eq(vanDays.id, dayId), eq(vanDays.companyId, companyId))).limit(1);
    if (day === undefined) throw new VanSalesError('That day could not be found.');
    const [order] = await db.select({ id: orders.id, number: orders.orderNumber, salesModule: orders.salesModule, status: orders.status, approvalStatus: orders.approvalStatus, customerId: orders.tradeCustomerId, name: orders.customerName }).from(orders).where(eq(orders.id, orderId)).limit(1);
    if (order === undefined) throw new VanSalesError('That order could not be found.');
    const [visit] = order.customerId === null ? [] : await db.select({ id: vanVisits.id }).from(vanVisits).where(and(eq(vanVisits.dayId, dayId), eq(vanVisits.customerId, order.customerId))).limit(1);
    const [plan] = await db.select({ method: orderDeliveries.method }).from(orderDeliveries).where(eq(orderDeliveries.orderId, orderId)).limit(1);
    const [live] = await db.select({ id: vanDrops.id }).from(vanDrops).where(and(eq(vanDrops.orderId, orderId), eq(vanDrops.state, 'planned'))).limit(1);
    const [anyLine] = await db.select({ id: orderItems.id }).from(orderItems).where(eq(orderItems.orderId, orderId)).limit(1);
    const [held] = await db.select({ id: stockReservations.id }).from(stockReservations).where(and(eq(stockReservations.refType, 'order'), eq(stockReservations.refId, orderId), inArray(stockReservations.state, ['held', 'partly_consumed']))).limit(1);
    const [person] = order.customerId === null ? [] : await db.select({ county: customers.countyOrState, town: customers.city, area: customers.street }).from(customers).where(eq(customers.id, order.customerId)).limit(1);
    return {
      visit,
      customerName: order.name,
      address: { county: text(person?.county), town: text(person?.town), area: text(person?.area) },
      facts: {
        dayStatus: day.status,
        vanAndOrders: day.vanId !== null && day.mode === 'both',
        order: { number: order.number, salesModule: order.salesModule, status: order.status, approvalStatus: order.approvalStatus, customerOnDay: visit !== undefined, deliveryMethod: plan?.method ?? null, alreadyOnADrop: live !== undefined, hasLines: anyLine !== undefined, holdsStock: held !== undefined },
      },
    };
  }
}
