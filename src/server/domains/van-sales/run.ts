import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customerAddresses, customers, orders, shifts, vanDayCollections, vanDayOrders, vanDayReturns, vanDays, vanDrops, vanLoads, vanVisits } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { parseCount } from '@/server/domains/selling/shifts/shift-rules';
import type { ShiftService } from '@/server/domains/selling/shifts/shift-service';
import { readDayStatus, readVisitStatus, VISIT_OVER_WORDS } from '@/lib/van-sales/days';
import { isId } from '@/lib/van-sales/people';
import { arrivalProblem, canMoveVisit, goOutProblem, metresBetween, readFinish, readFloat, readPosition, readWhy } from '@/lib/van-sales/run';
import { routeModeProblem, type RouteMode } from '@/lib/van-sales/settings';
import { recordDayEvent } from './day-events';
import { ownDay } from './own-day';
import { backProblem } from '@/lib/van-sales/back';
import type { DayDetail, VanDayService } from './days';
import { constraintOf, VanSalesError } from './errors';
import type { VanSalesSettingsService } from './settings-service';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const modeOf = (value: string): RouteMode => (value === 'van_sell' || value === 'pre_sell' ? value : 'both');

/**
 * Running a van day (docs/architecture/van-sales.md §7, §10): the rep sends the day out, which opens the van's till shift with a counted float,
 * and works through the visits: arrive (with where the phone is), finish with no sale and a reason, skip, find a shop shut, or add a customer on
 * the road where the company allows it. A rep runs only their own day: the cash and the stock are in their custody. Every step is in the day's
 * history with the server's time (the phone's own time is kept beside it).
 */
/** How a visit with something taken at it is recorded: sales, orders, or both. */
const storedOutcome = (n: { sales: number; orders: number; delivered: number; collected: number }): 'sold' | 'order_taken' | 'sold_and_ordered' | 'delivered_only' | 'collected_only' | 'returned_only' => {
  if (n.sales > 0 && n.orders > 0) return 'sold_and_ordered';
  if (n.orders > 0) return 'order_taken';
  if (n.sales > 0) return 'sold';
  if (n.delivered > 0) return 'delivered_only';
  return n.collected > 0 ? 'collected_only' : 'returned_only';
};

export class VanRunService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly shifts: ShiftService,
    private readonly days: VanDayService,
    private readonly settings: VanSalesSettingsService,
  ) {}

  private async ownDay(companyId: string, actor: Actor, dayId: string, maySell: boolean) {
    return await ownDay(this.db, companyId, actor, dayId, maySell);
  }

  // ── Coming back ──────────────────────────────────────────────────────

  /** Why the day cannot come back yet (an unfinished visit, a delivery with no result), or null: for the screen and for the step itself. */
  async backProblemOf(companyId: string, dayId: string): Promise<string | null> {
    const [day] = await this.db.select({ status: vanDays.status }).from(vanDays).where(and(eq(vanDays.id, dayId), eq(vanDays.companyId, companyId)));
    if (day === undefined) return null;
    const visits = await this.db.select({ name: customers.name, status: vanVisits.status }).from(vanVisits).innerJoin(customers, eq(customers.id, vanVisits.customerId)).where(eq(vanVisits.dayId, dayId)).orderBy(asc(vanVisits.sequence));
    const drops = await this.db.select({ number: orders.orderNumber }).from(vanDrops).innerJoin(orders, eq(orders.id, vanDrops.orderId)).where(and(eq(vanDrops.dayId, dayId), eq(vanDrops.state, 'planned'))).orderBy(asc(vanDrops.createdAt));
    return backProblem({ dayStatus: day.status, visits, openDeliveries: drops.map((d) => d.number) });
  }

  /** The rep says they are back at the depot: every visit is finished or skipped and every delivery has its result. Selling stops; the unload and the count follow. */
  async comeBack(companyId: string, actor: Actor, dayId: string, raw: unknown, maySell: boolean): Promise<void> {
    const i = obj(raw);
    const own = await this.ownDay(companyId, actor, dayId, maySell);
    if (i.expectedVersion !== own.d.version) throw new VanSalesError('Someone else changed this day while you were looking at it. Reload the page to see the latest.');
    const problem = await this.backProblemOf(companyId, dayId);
    if (problem !== null) throw new VanSalesError(problem);
    await this.db.transaction(async (tx) => {
      const [locked] = await tx.select().from(vanDays).where(eq(vanDays.id, dayId)).limit(1).for('update');
      if (locked?.version !== own.d.version || readDayStatus(locked.status) !== 'out') throw new VanSalesError('The day changed while it was coming back. Reload the page and try again.');
      await tx.update(vanDays).set({ status: 'returning', version: locked.version + 1, updatedAt: new Date() }).where(eq(vanDays.id, dayId));
      await recordDayEvent(tx, this.decisions, companyId, dayId, actor, 'day.back', { from: 'out', to: 'returning' });
    });
  }

  // ── Going out ────────────────────────────────────────────────────────

  /** Sends the day out. A day that sells from a van opens the van's till with the cash counted into it. */
  async sendOut(companyId: string, actor: Actor, dayId: string, raw: unknown, maySell: boolean): Promise<DayDetail> {
    const i = obj(raw);
    const own = await this.ownDay(companyId, actor, dayId, maySell);
    const day = own.d;
    const mode = modeOf(day.mode);
    const status = readDayStatus(day.status) ?? 'planned';
    const modeProblem = routeModeProblem(await this.settings.current(companyId), mode);
    if (modeProblem !== null) throw new VanSalesError(modeProblem);
    const [signed] = await this.db.select({ id: vanLoads.id }).from(vanLoads).where(and(eq(vanLoads.dayId, day.id), eq(vanLoads.kind, 'load'), isNull(vanLoads.cancelledAt), isNotNull(vanLoads.signedAt))).limit(1);
    const problem = goOutProblem({ status, mode, loadSigned: signed !== undefined });
    if (problem !== null) throw new VanSalesError(problem);
    if (i.expectedVersion !== day.version) throw new VanSalesError('Someone else changed this day while you were looking at it. Reload the page to see the latest.');

    let shiftId: string | null = null;
    let opening = 0;
    if (day.vanId !== null && own.registerId !== null) {
      const float = readFloat(i.float);
      if (!float.ok) throw new VanSalesError(float.error);
      opening = float.amount;
      // A shift this rep already opened on the van's till for this day (an earlier attempt that did not finish) is used again, never a second one.
      const [mine] = await this.db
        .select({ id: shifts.id, float: shifts.openingFloat })
        .from(shifts)
        .where(and(eq(shifts.registerId, own.registerId), eq(shifts.openedBy, actor.id ?? ''), inArray(shifts.status, ['open', 'closing']), sql`NOT EXISTS (SELECT 1 FROM van_days d WHERE d.shift_id = ${shifts.id})`))
        .limit(1);
      if (mine !== undefined) {
        shiftId = mine.id;
        opening = Number(mine.float);
      } else {
        const count = parseCount({ total: opening }, 'cash');
        if (!count.ok) throw new VanSalesError(count.error);
        const opened = await this.shifts.open(companyId, { userId: actor.id ?? '', branchId: null }, { registerId: own.registerId, float: count });
        if (!opened.ok) throw new VanSalesError(opened.error);
        shiftId = opened.shiftId;
      }
    }

    await this.db
      .transaction(async (tx) => {
        const [locked] = await tx.select().from(vanDays).where(eq(vanDays.id, day.id)).limit(1).for('update');
        const now = readDayStatus(locked?.status ?? '') ?? 'planned';
        if (locked?.version !== day.version || (now !== 'planned' && now !== 'loading')) throw new VanSalesError('The day changed while it was being sent out. Reload the page and try again.');
        await tx.update(vanDays).set({ status: 'out', shiftId, version: locked.version + 1, updatedAt: new Date() }).where(eq(vanDays.id, day.id));
        await recordDayEvent(tx, this.decisions, companyId, day.id, actor, 'day.out', { from: now, to: 'out', detail: { float: opening, shiftId } });
      })
      .catch((error: unknown) => {
        if (constraintOf(error) === 'van_days_status_chk') throw new VanSalesError('The day could not be sent out.');
        throw error;
      });
    return await this.mustFind(companyId, day.id);
  }

  // ── The visits ───────────────────────────────────────────────────────

  private async runningDay(companyId: string, actor: Actor, dayId: string, maySell: boolean) {
    const own = await this.ownDay(companyId, actor, dayId, maySell);
    if (readDayStatus(own.d.status) !== 'out') throw new VanSalesError('The visits are made while the day is out on the route. Send the day out first.');
    return own;
  }

  private async visitOf(tx: Tx, dayId: string, visitId: string) {
    if (!isId(visitId)) throw new VanSalesError('That visit could not be found.');
    const [row] = await tx.select({ v: vanVisits, name: customers.name, customerId: customers.id }).from(vanVisits).innerJoin(customers, eq(customers.id, vanVisits.customerId)).where(and(eq(vanVisits.id, visitId), eq(vanVisits.dayId, dayId))).limit(1).for('update', { of: vanVisits });
    if (row === undefined) throw new VanSalesError('That visit could not be found on this day.');
    return row;
  }

  private bump(tx: Tx, dayId: string, version: number) {
    return tx.update(vanDays).set({ version: version + 1, updatedAt: new Date() }).where(eq(vanDays.id, dayId));
  }

  /** The rep arrives at a customer: the time, where the phone is, and how far that is from the customer's pin. */
  async arrive(companyId: string, actor: Actor, dayId: string, visitId: string, raw: unknown, maySell: boolean): Promise<DayDetail> {
    const i = obj(raw);
    const own = await this.runningDay(companyId, actor, dayId, maySell);
    const position = readPosition(i.position);
    if (!position.ok) throw new VanSalesError(position.error);
    const settings = await this.settings.current(companyId);
    await this.db.transaction(async (tx) => {
      const [day] = await tx.select().from(vanDays).where(eq(vanDays.id, own.d.id)).limit(1).for('update');
      if (day === undefined || readDayStatus(day.status) !== 'out') throw new VanSalesError('The day is no longer out. Reload the page.');
      const visit = await this.visitOf(tx, day.id, visitId);
      const status = readVisitStatus(visit.v.status);
      if (status === 'arrived') throw new VanSalesError(`You are already at ${visit.name}.`);
      if (!canMoveVisit(status, 'arrived')) throw new VanSalesError(`The visit to ${visit.name} is already ${VISIT_OVER_WORDS[status] ?? 'over'}.`);
      const [other] = await tx.select({ name: customers.name }).from(vanVisits).innerJoin(customers, eq(customers.id, vanVisits.customerId)).where(and(eq(vanVisits.dayId, day.id), eq(vanVisits.status, 'arrived'), ne(vanVisits.id, visit.v.id))).limit(1);
      if (other !== undefined) throw new VanSalesError(`Finish the visit at ${other.name} before starting another.`);
      const [pin] = await tx.select({ lat: customerAddresses.latitude, lng: customerAddresses.longitude }).from(customerAddresses).where(and(eq(customerAddresses.customerId, visit.customerId), isNotNull(customerAddresses.latitude), isNotNull(customerAddresses.longitude))).orderBy(sql`${customerAddresses.isDefault} DESC`).limit(1);
      const distance = position.point !== null && pin !== undefined ? metresBetween(position.point, { latitude: Number(pin.lat), longitude: Number(pin.lng) }) : null;
      const problem = arrivalProblem(settings, visit.name, position.point, distance);
      if (problem !== null) throw new VanSalesError(problem);
      const device = typeof i.deviceTime === 'string' && !Number.isNaN(Date.parse(i.deviceTime)) ? new Date(i.deviceTime) : null;
      await tx.update(vanVisits).set({ status: 'arrived', arrivedAt: new Date(), deviceArrivedAt: device, arrivedLatitude: position.point === null ? null : position.point.latitude.toFixed(6), arrivedLongitude: position.point === null ? null : position.point.longitude.toFixed(6), arrivedDistanceM: distance, version: visit.v.version + 1, updatedAt: new Date() }).where(eq(vanVisits.id, visit.v.id));
      await this.bump(tx, day.id, day.version);
      await recordDayEvent(tx, this.decisions, companyId, day.id, actor, 'visit.arrived', { detail: { customer: visit.name, customerId: visit.customerId, distanceM: distance } });
    });
    return await this.mustFind(companyId, dayId);
  }

  /** Ends a visit where nothing was sold, with the reason. */
  async finish(companyId: string, actor: Actor, dayId: string, visitId: string, raw: unknown, maySell: boolean): Promise<DayDetail> {
    const read = readFinish(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const own = await this.runningDay(companyId, actor, dayId, maySell);
    await this.db.transaction(async (tx) => {
      const [day] = await tx.select().from(vanDays).where(eq(vanDays.id, own.d.id)).limit(1).for('update');
      if (day === undefined) throw new VanSalesError('That day could not be found.');
      const visit = await this.visitOf(tx, day.id, visitId);
      if (visit.v.status !== 'arrived') throw new VanSalesError(`Arrive at ${visit.name} before finishing the visit.`);
      const made = await tx.select({ kind: vanDayOrders.kind, n: sql<number>`count(*)::int` }).from(vanDayOrders).where(eq(vanDayOrders.visitId, visit.v.id)).groupBy(vanDayOrders.kind);
      const orders = made.find((m) => m.kind === 'order')?.n ?? 0;
      const sales = made.filter((m) => m.kind !== 'order').reduce((n, m) => n + m.n, 0);
      const [dropped] = await tx.select({ n: sql<number>`count(*)::int` }).from(vanDrops).where(and(eq(vanDrops.visitId, visit.v.id), eq(vanDrops.state, 'delivered')));
      const delivered = dropped?.n ?? 0;
      const [paid] = await tx.select({ n: sql<number>`count(*)::int` }).from(vanDayCollections).where(eq(vanDayCollections.visitId, visit.v.id));
      const collected = paid?.n ?? 0;
      const [back] = await tx.select({ n: sql<number>`count(*)::int` }).from(vanDayReturns).where(eq(vanDayReturns.visitId, visit.v.id));
      const returned = back?.n ?? 0;
      const [open] = await tx.select({ n: sql<number>`count(*)::int` }).from(vanDrops).where(and(eq(vanDrops.visitId, visit.v.id), eq(vanDrops.state, 'planned')));
      if ((open?.n ?? 0) > 0) throw new VanSalesError(`${visit.name} has a delivery that is not dealt with. Deliver it, or say why it was not delivered.`);
      const done = sales + orders + delivered + collected + returned;
      if (read.finish.outcome === 'sold' && done === 0) throw new VanSalesError(`Nothing has been sold, ordered, delivered, collected or returned at ${visit.name}. Do one of these here, or finish the visit with no sale.`);
      if (read.finish.outcome === 'no_sale' && done > 0) throw new VanSalesError(`There ${done === 1 ? 'is a sale, order, delivery, payment or return' : 'are sales, orders, deliveries, payments or returns'} at ${visit.name}, so the visit is finished as done, not as no sale.`);
      const stored = read.finish.outcome === 'no_sale' ? 'no_sale' : storedOutcome({ sales, orders, delivered, collected });
      await tx.update(vanVisits).set({ status: 'done', outcome: stored, noSaleReason: read.finish.reason, departedAt: new Date(), version: visit.v.version + 1, updatedAt: new Date() }).where(eq(vanVisits.id, visit.v.id));
      await this.bump(tx, day.id, day.version);
      await recordDayEvent(tx, this.decisions, companyId, day.id, actor, 'visit.done', { reason: read.finish.reason ?? undefined, detail: { customer: visit.name, customerId: visit.customerId, outcome: read.finish.outcome } });
    });
    return await this.mustFind(companyId, dayId);
  }

  /** Skips a customer the rep will not visit today, with the reason. */
  async skip(companyId: string, actor: Actor, dayId: string, visitId: string, reason: unknown, maySell: boolean): Promise<DayDetail> {
    const why = readWhy(reason);
    if (!why.ok) throw new VanSalesError(why.error);
    const own = await this.runningDay(companyId, actor, dayId, maySell);
    await this.db.transaction(async (tx) => {
      const [day] = await tx.select().from(vanDays).where(eq(vanDays.id, own.d.id)).limit(1).for('update');
      if (day === undefined) throw new VanSalesError('That day could not be found.');
      const visit = await this.visitOf(tx, day.id, visitId);
      if (visit.v.status !== 'planned') throw new VanSalesError(`The visit to ${visit.name} has already started or finished, so it cannot be skipped.`);
      await tx.update(vanVisits).set({ status: 'skipped', noSaleReason: why.reason, departedAt: new Date(), version: visit.v.version + 1, updatedAt: new Date() }).where(eq(vanVisits.id, visit.v.id));
      await this.bump(tx, day.id, day.version);
      await recordDayEvent(tx, this.decisions, companyId, day.id, actor, 'visit.skipped', { reason: why.reason, detail: { customer: visit.name, customerId: visit.customerId } });
    });
    return await this.mustFind(companyId, dayId);
  }

  /** The shop was found shut: the visit is over, whether or not the rep had arrived. */
  async closedShop(companyId: string, actor: Actor, dayId: string, visitId: string, reason: unknown, maySell: boolean): Promise<DayDetail> {
    const typed = typeof reason === 'string' && reason.trim() !== '' ? readWhy(reason) : null;
    if (typed !== null && !typed.ok) throw new VanSalesError(typed.error);
    const own = await this.runningDay(companyId, actor, dayId, maySell);
    await this.db.transaction(async (tx) => {
      const [day] = await tx.select().from(vanDays).where(eq(vanDays.id, own.d.id)).limit(1).for('update');
      if (day === undefined) throw new VanSalesError('That day could not be found.');
      const visit = await this.visitOf(tx, day.id, visitId);
      if (!canMoveVisit(readVisitStatus(visit.v.status), 'closed_shop')) throw new VanSalesError(`The visit to ${visit.name} is already finished.`);
      await tx.update(vanVisits).set({ status: 'closed_shop', noSaleReason: typed?.ok === true ? typed.reason : null, departedAt: new Date(), version: visit.v.version + 1, updatedAt: new Date() }).where(eq(vanVisits.id, visit.v.id));
      await this.bump(tx, day.id, day.version);
      await recordDayEvent(tx, this.decisions, companyId, day.id, actor, 'visit.closed_shop', { reason: typed?.ok === true ? typed.reason : undefined, detail: { customer: visit.name, customerId: visit.customerId } });
    });
    return await this.mustFind(companyId, dayId);
  }

  /** A customer who is not on the route's list for the day, added by the rep on the road: only where the company lets reps sell off the route. */
  async addOnRoute(companyId: string, actor: Actor, dayId: string, customerId: unknown, maySell: boolean): Promise<DayDetail> {
    if (!isId(customerId)) throw new VanSalesError('Choose the customer from the list.');
    const own = await this.runningDay(companyId, actor, dayId, maySell);
    if ((await this.settings.current(companyId)).offRoute === 'refuse') throw new VanSalesError('This company lets reps visit only the customers on the route.');
    await this.db
      .transaction(async (tx) => {
        const [day] = await tx.select().from(vanDays).where(eq(vanDays.id, own.d.id)).limit(1).for('update');
        if (day === undefined) throw new VanSalesError('That day could not be found.');
        const [customer] = await tx.select({ name: customers.name, isActive: customers.isActive, isWalkIn: customers.isWalkIn }).from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId))).limit(1);
        if (customer?.isActive !== true) throw new VanSalesError('Choose a customer who is in use.');
        if (customer.isWalkIn) throw new VanSalesError('The walk-in customer is whoever walks up to a counter, so it cannot be a visit.');
        const [last] = await tx.select({ n: sql<number>`COALESCE(MAX(${vanVisits.sequence}), 0)::int` }).from(vanVisits).where(eq(vanVisits.dayId, day.id));
        await tx.insert(vanVisits).values({ companyId, dayId: day.id, customerId, sequence: (last?.n ?? 0) + 1 });
        await this.bump(tx, day.id, day.version);
        await recordDayEvent(tx, this.decisions, companyId, day.id, actor, 'day.visit_added_on_route', { detail: { customer: customer.name, customerId } });
      })
      .catch((error: unknown) => {
        if (constraintOf(error) === 'van_visits_day_customer_uidx') throw new VanSalesError('That customer is already on this day\'s visits.');
        throw error;
      });
    return await this.mustFind(companyId, dayId);
  }

  private async mustFind(companyId: string, id: string): Promise<DayDetail> {
    const found = await this.days.find(companyId, id);
    if (found === null) throw new VanSalesError('That day could not be found.');
    return found;
  }
}

