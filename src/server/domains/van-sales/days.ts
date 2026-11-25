import { and, asc, desc, eq, ilike, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, customers, routeStops, salesReps, salesRoutes, stockBalances, stockDocuments, users, vanDayEvents, vanDays, vanLoads, vanVisits, vans } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { NumberSeriesService } from '@/server/kernel/numbering/service';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { canArrangeVisits, canMoveDay, DAY_EVENT_WORDS, DAY_STATUS_WORDS, modesLacking, readDayStatus, readPlan, type DayStatus, type VisitStatus } from '@/lib/van-sales/days';
import { isId, readReason } from '@/lib/van-sales/people';
import { movedOrder } from '@/lib/van-sales/routes';
import { routeModeProblem, type RouteMode } from '@/lib/van-sales/settings';
import { dueStops } from '@/lib/van-sales/visits';
import { decodeCursor, encodeCursor, escapeLike } from '@/server/domains/lookups/request';
import { PAGE_SIZE, searchText, type PageInput } from '@/server/domains/settings/paging';
import { recordDayEvent, type DayEventEntry } from './day-events';
import { constraintOf, VanSalesError } from './errors';
import { customerWarning } from './routes';
import type { VanSalesSettingsService } from './settings-service';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface DayView {
  id: string;
  number: string;
  routeId: string;
  routeName: string;
  routeCode: string;
  branchId: string;
  branchName: string;
  repId: string;
  repName: string;
  vanId: string | null;
  vanName: string | null;
  date: string;
  mode: RouteMode;
  status: DayStatus;
  statusWords: string;
  statusReason: string | null;
  version: number;
  visits: number;
  visitsDone: number;
}

export interface VisitView {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  customerPlace: string | null;
  customerWarning: string | null;
  sequence: number;
  status: VisitStatus;
  /** From the route's stop, or added to this day by hand. */
  fromRoute: boolean;
  note: string | null;
  version: number;
}

export interface EventView {
  id: number;
  at: string;
  action: string;
  words: string;
  by: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  reason: string | null;
}

export interface DayDetail {
  day: DayView;
  visits: VisitView[];
  events: EventView[];
}

export type DayFilter = 'open' | 'closed' | 'cancelled' | 'all';
export interface DayPageInput extends PageInput {
  status?: DayFilter;
}

const OPEN: DayStatus[] = ['planned', 'loading', 'out', 'returning', 'reconciling'];
const modeOf = (value: string): RouteMode => (value === 'van_sell' || value === 'pre_sell' ? value : 'both');
const visitStatusOf = (value: string): VisitStatus => (value === 'arrived' || value === 'done' || value === 'skipped' || value === 'closed_shop' ? value : 'planned');

const TAKEN: Record<string, string> = {
  van_days_rep_date_uidx: 'That rep already has a day on that date.',
  van_days_van_date_uidx: 'That van already has a day on that date.',
  van_days_route_date_uidx: 'This route already has a day on that date.',
  van_visits_day_customer_uidx: 'That customer is already on this day\'s visits.',
};
const refuse = (error: unknown): never => {
  const known = TAKEN[constraintOf(error) ?? ''];
  if (known !== undefined) throw new VanSalesError(known);
  throw error;
};

/**
 * Van days (docs/architecture/van-sales.md §4.3, §6.1, §7): a day is planned from a route and a date, with the customers due that day copied
 * in as its visits in the order of the round. Its rep and van are held for the date, every step it takes is written to an append-only history
 * with the server's time, who did it and why, and it is cancelled (with a reason) only before it goes out. The steps after planning (loading,
 * out, back, counted, closed) are added by the slices that own them, through the same moves and the same history.
 */
export class VanDayService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly numbering: Pick<NumberSeriesService, 'assign'>,
    private readonly settings: VanSalesSettingsService,
  ) {}

  // ── Reading ──────────────────────────────────────────────────────────

  private select() {
    return this.db
      .select({
        d: vanDays,
        routeName: salesRoutes.name,
        routeCode: salesRoutes.code,
        branchName: branches.name,
        repName: salesReps.name,
        vanName: vans.name,
        visits: sql<number>`(SELECT count(*)::int FROM ${vanVisits} v WHERE v.day_id = ${vanDays.id})`,
        visitsDone: sql<number>`(SELECT count(*)::int FROM ${vanVisits} v WHERE v.day_id = ${vanDays.id} AND v.status IN ('done','skipped','closed_shop'))`,
      })
      .from(vanDays)
      .innerJoin(salesRoutes, eq(salesRoutes.id, vanDays.routeId))
      .innerJoin(branches, eq(branches.id, vanDays.branchId))
      .innerJoin(salesReps, eq(salesReps.id, vanDays.repId))
      .leftJoin(vans, eq(vans.id, vanDays.vanId));
  }

  private view(x: Awaited<ReturnType<VanDayService['select']>>[number]): DayView {
    const d = x.d;
    const status = readDayStatus(d.status) ?? 'planned';
    return {
      id: d.id,
      number: d.number,
      routeId: d.routeId,
      routeName: x.routeName,
      routeCode: x.routeCode,
      branchId: d.branchId,
      branchName: x.branchName,
      repId: d.repId,
      repName: x.repName,
      vanId: d.vanId,
      vanName: x.vanName,
      date: d.dayDate,
      mode: modeOf(d.mode),
      status,
      statusWords: DAY_STATUS_WORDS[status],
      statusReason: d.statusReason,
      version: d.version,
      visits: x.visits,
      visitsDone: x.visitsDone,
    };
  }

  /** One page of days, the latest date first. */
  async page(companyId: string, input: DayPageInput): Promise<{ rows: DayView[]; nextCursor: string | null }> {
    const filter = input.status ?? 'open';
    const query = searchText(input);
    const after = typeof input.cursor === 'string' && input.cursor !== '' ? decodeCursor(input.cursor) : null;
    const conditions: (SQL | undefined)[] = [
      eq(vanDays.companyId, companyId),
      filter === 'open' ? inArray(vanDays.status, OPEN) : undefined,
      filter === 'closed' || filter === 'cancelled' ? eq(vanDays.status, filter) : undefined,
      query === '' ? undefined : or(ilike(vanDays.number, `%${escapeLike(query)}%`), ilike(salesRoutes.name, `%${escapeLike(query)}%`), ilike(salesReps.name, `%${escapeLike(query)}%`)),
      after === null ? undefined : sql`(${vanDays.dayDate}, ${vanDays.id}) < (${after.k}::date, ${after.id}::uuid)`,
    ];
    const rows = await this.select()
      .where(and(...conditions))
      .orderBy(desc(vanDays.dayDate), desc(vanDays.id))
      .limit(PAGE_SIZE + 1);
    const page = rows.slice(0, PAGE_SIZE);
    const last = page.at(-1);
    return { rows: page.map((x) => this.view(x)), nextCursor: rows.length > PAGE_SIZE && last !== undefined ? encodeCursor({ k: last.d.dayDate, id: last.d.id }) : null };
  }

  /** The days still to run or running, counted for the home of van sales; and how many fall today. */
  async counts(companyId: string): Promise<{ open: number; today: number }> {
    const [row] = await this.db
      .select({
        open: sql<number>`count(*) FILTER (WHERE ${inArray(vanDays.status, OPEN)})::int`,
        today: sql<number>`count(*) FILTER (WHERE ${vanDays.dayDate} = ${businessDate()}::date AND ${vanDays.status} <> 'cancelled')::int`,
      })
      .from(vanDays)
      .where(eq(vanDays.companyId, companyId));
    return { open: row?.open ?? 0, today: row?.today ?? 0 };
  }

  private async visitsOf(companyId: string, dayId: string): Promise<VisitView[]> {
    const rows = await this.db
      .select({ v: vanVisits, name: customers.name, phone: customers.phone, city: customers.city, isActive: customers.isActive, blocked: customers.blocked, note: routeStops.note })
      .from(vanVisits)
      .innerJoin(customers, eq(customers.id, vanVisits.customerId))
      .leftJoin(routeStops, eq(routeStops.id, vanVisits.stopId))
      .where(and(eq(vanVisits.companyId, companyId), eq(vanVisits.dayId, dayId)))
      .orderBy(asc(vanVisits.sequence), asc(vanVisits.id))
      .limit(1000);
    return rows.map((r) => ({
      id: r.v.id,
      customerId: r.v.customerId,
      customerName: r.name,
      customerPhone: r.phone,
      customerPlace: r.city,
      customerWarning: customerWarning(r),
      sequence: r.v.sequence,
      status: visitStatusOf(r.v.status),
      fromRoute: r.v.stopId !== null,
      note: r.note,
      version: r.v.version,
    }));
  }

  private async eventsOf(companyId: string, dayId: string): Promise<EventView[]> {
    const rows = await this.db
      .select({ e: vanDayEvents, by: users.name })
      .from(vanDayEvents)
      .leftJoin(users, sql`${users.id}::text = ${vanDayEvents.actorId}`)
      .where(and(eq(vanDayEvents.companyId, companyId), eq(vanDayEvents.dayId, dayId)))
      .orderBy(asc(vanDayEvents.id))
      .limit(500);
    return rows.map((r) => ({ id: r.e.id, at: r.e.occurredAt.toISOString(), action: r.e.action, words: DAY_EVENT_WORDS[r.e.action] ?? r.e.action, by: r.by, fromStatus: r.e.fromStatus, toStatus: r.e.toStatus, reason: r.e.reason }));
  }

  /** The day, or null when there is none like it (a malformed id counts as none). */
  async find(companyId: string, id: string): Promise<DayDetail | null> {
    if (!isId(id)) return null;
    const [row] = await this.select().where(and(eq(vanDays.companyId, companyId), eq(vanDays.id, id))).limit(1);
    if (row === undefined) return null;
    const [visits, events] = await Promise.all([this.visitsOf(companyId, id), this.eventsOf(companyId, id)]);
    return { day: this.view(row), visits, events };
  }

  // ── Planning ─────────────────────────────────────────────────────────

  private async record(tx: Tx, companyId: string, dayId: string, actor: Actor, action: string, entry: DayEventEntry = {}): Promise<void> {
    await recordDayEvent(tx, this.decisions, companyId, dayId, actor, action, entry);
  }

  /** Plans a day for a route on a date: the rep and van from the route unless others are chosen, and the customers due that day as its visits. */
  async plan(companyId: string, actor: Actor, raw: unknown): Promise<DayDetail> {
    const read = readPlan(raw, businessDate());
    if (!read.ok) throw new VanSalesError(read.error);
    const plan = read.plan;
    const settings = await this.settings.current(companyId);
    const id = await this.db
      .transaction(async (tx) => {
        const [route] = await tx.select().from(salesRoutes).where(and(eq(salesRoutes.id, plan.routeId), eq(salesRoutes.companyId, companyId))).limit(1).for('share');
        if (route === undefined) throw new VanSalesError('That route could not be found.');
        if (route.status !== 'active') throw new VanSalesError('That route is stopped. Use it again before planning a day on it.');
        const mode = modeOf(route.mode);
        const modeProblem = routeModeProblem(settings, mode);
        if (modeProblem !== null) throw new VanSalesError(modeProblem);

        const repId = plan.repId ?? route.defaultRepId;
        if (repId === null) throw new VanSalesError('This route has no usual rep. Choose the rep for the day.');
        const [rep] = await tx.select({ id: salesReps.id, name: salesReps.name, status: salesReps.status, modes: salesReps.modes }).from(salesReps).where(and(eq(salesReps.id, repId), eq(salesReps.companyId, companyId))).limit(1);
        if (rep?.status !== 'active') throw new VanSalesError('Choose a sales rep who is selling.');
        const lacking = modesLacking(mode, rep.modes);
        if (lacking.length > 0) throw new VanSalesError(`${rep.name} does not do ${lacking.join(' or ')}, which this route needs. Choose another rep.`);

        let vanId: string | null = null;
        let vanName: string | null = null;
        if (mode === 'pre_sell') {
          if (plan.vanId !== null) throw new VanSalesError('A day that only takes orders sells nothing from a van, so it has no van.');
        } else {
          vanId = plan.vanId ?? route.defaultVanId;
          if (vanId === null) throw new VanSalesError('This route has no usual van. Choose the van for the day.');
          const [van] = await tx.select({ name: vans.name, status: vans.status, branchId: vans.branchId }).from(vans).where(and(eq(vans.id, vanId), eq(vans.companyId, companyId))).limit(1);
          if (van?.status !== 'active') throw new VanSalesError('Choose a van that is in use.');
          if (van.branchId !== route.branchId) throw new VanSalesError(`The van ${van.name} belongs to another branch than the route's. Choose a van from the route's branch.`);
          vanName = van.name;
        }

        // A route, a rep and a van each have one day on a date. Said in this order, with the day that has them, so the person knows what to change.
        const held = await tx
          .select({ number: vanDays.number, routeId: vanDays.routeId, repId: vanDays.repId, vanId: vanDays.vanId })
          .from(vanDays)
          .where(and(eq(vanDays.companyId, companyId), eq(vanDays.dayDate, plan.date), ne(vanDays.status, 'cancelled'), or(eq(vanDays.routeId, route.id), eq(vanDays.repId, rep.id), vanId === null ? undefined : eq(vanDays.vanId, vanId))));
        const byRoute = held.find((d) => d.routeId === route.id);
        if (byRoute !== undefined) throw new VanSalesError(`This route already has a day on that date (${byRoute.number}). Open it, or cancel it first.`);
        const byRep = held.find((d) => d.repId === rep.id);
        if (byRep !== undefined) throw new VanSalesError(`Sales rep ${rep.name} already has a day on that date (${byRep.number}). Choose another rep.`);
        const byVan = held.find((d) => vanId !== null && d.vanId === vanId);
        if (byVan !== undefined) throw new VanSalesError(`The van ${vanName ?? ''} already has a day on that date (${byVan.number}). Choose another van.`);

        const stops = await tx
          .select({ id: routeStops.id, customerId: routeStops.customerId, sequence: routeStops.sequence, visitDays: routeStops.visitDays, everyWeeks: routeStops.everyWeeks, anchorDate: routeStops.anchorDate, active: routeStops.active, isActive: customers.isActive })
          .from(routeStops)
          .innerJoin(customers, eq(customers.id, routeStops.customerId))
          .where(and(eq(routeStops.routeId, route.id), eq(routeStops.active, true)))
          .orderBy(asc(routeStops.sequence), asc(routeStops.id));
        const due = dueStops(stops.filter((s) => s.isActive).map((s) => ({ ...s, every: s.everyWeeks === 2 || s.everyWeeks === 4 ? s.everyWeeks : 1, anchor: s.anchorDate })), plan.date);
        if (due.length === 0) throw new VanSalesError('No customer on this route is due on that date. Choose another date, or put customers on the route first.');

        const dayId = crypto.randomUUID();
        const { number } = await this.numbering.assign('van_day', { companyId, date: businessDate(), document: { kind: 'van_day', id: dayId } }, tx);
        await tx.insert(vanDays).values({ id: dayId, companyId, number, routeId: route.id, branchId: route.branchId, repId: rep.id, vanId, dayDate: plan.date, mode, createdBy: actor.id ?? 'system' });
        await tx.insert(vanVisits).values(due.map((s, i) => ({ companyId, dayId, customerId: s.customerId, stopId: s.id, sequence: i + 1 })));
        await this.record(tx, companyId, dayId, actor, 'day.planned', { to: 'planned', detail: { number, route: route.name, date: plan.date, rep: rep.name, visits: due.length, vanId } });
        return dayId;
      })
      .catch(refuse);
    const found = await this.find(companyId, id);
    if (found === null) throw new VanSalesError('The day could not be found after it was planned.');
    return found;
  }

  private async locked(tx: Tx, companyId: string, id: string, expectedVersion?: unknown) {
    if (!isId(id)) throw new VanSalesError('That day could not be found.');
    const [row] = await tx.select().from(vanDays).where(and(eq(vanDays.companyId, companyId), eq(vanDays.id, id))).limit(1).for('update');
    if (row === undefined) throw new VanSalesError('That day could not be found.');
    if (expectedVersion !== undefined && expectedVersion !== row.version) throw new VanSalesError('Someone else changed this day while you were looking at it. Reload the page to see the latest.');
    return row;
  }

  /** Cancels a day that has not gone out, with a reason: its rep, van and date are given back. */
  async cancel(companyId: string, actor: Actor, id: string, input: { reason: unknown; expectedVersion: unknown }): Promise<DayDetail> {
    const why = readReason(input.reason);
    if (!why.ok) throw new VanSalesError(why.error);
    await this.db.transaction(async (tx) => {
      const day = await this.locked(tx, companyId, id, input.expectedVersion);
      const from = readDayStatus(day.status) ?? 'planned';
      if (!canMoveDay(from, 'cancelled')) throw new VanSalesError(from === 'cancelled' ? 'This day is already cancelled.' : `A day that is ${DAY_STATUS_WORDS[from].toLowerCase()} cannot be cancelled.`);
      await this.loadProblem(tx, day.id, day.vanId);
      await tx.update(vanDays).set({ status: 'cancelled', statusReason: why.reason, version: day.version + 1, updatedAt: new Date() }).where(eq(vanDays.id, day.id));
      await this.record(tx, companyId, day.id, actor, 'day.cancelled', { from, to: 'cancelled', reason: why.reason });
    });
    const found = await this.find(companyId, id);
    if (found === null) throw new VanSalesError('That day could not be found.');
    return found;
  }

  /**
   * A day with stock loaded for it is not cancelled until that stock is back: a load not yet sent is called off first, one on its way is
   * signed for or settled, and what is on the van goes back to the warehouse by a transfer.
   */
  private async loadProblem(tx: Tx, dayId: string, vanId: string | null): Promise<void> {
    const loads = await tx
      .select({ number: stockDocuments.number, state: stockDocuments.state, locationId: vans.locationId })
      .from(vanLoads)
      .innerJoin(stockDocuments, eq(stockDocuments.id, vanLoads.transferId))
      .innerJoin(vanDays, eq(vanDays.id, vanLoads.dayId))
      .leftJoin(vans, eq(vans.id, vanDays.vanId))
      .where(and(eq(vanLoads.dayId, dayId), isNull(vanLoads.cancelledAt)));
    const unsent = loads.find((l) => ['draft', 'requested', 'approved'].includes(l.state));
    if (unsent !== undefined) throw new VanSalesError(`The load ${unsent.number} has not left the warehouse. Call it off first, then cancel the day.`);
    const travelling = loads.find((l) => l.state === 'shipped' || l.state === 'partly_received');
    if (travelling !== undefined) throw new VanSalesError(`The load ${travelling.number} is on its way to the van. Sign for it, or settle what did not arrive under Stock › Transfers, before cancelling the day.`);
    const location = loads[0]?.locationId ?? null;
    if (loads.length > 0 && vanId !== null && location !== null) {
      const [held] = await tx.select({ n: sql<number>`count(*)::int` }).from(stockBalances).where(and(eq(stockBalances.locationId, location), sql`(${stockBalances.onHand} <> 0 OR ${stockBalances.reserved} <> 0)`));
      if ((held?.n ?? 0) > 0) throw new VanSalesError('Stock from this day\'s load is still on the van. Bring it back to the warehouse with a transfer from the van (Stock › Transfers), then cancel the day.');
    }
  }

  // ── The visits, while the day is being got ready ─────────────────────

  private async arrangeable(tx: Tx, companyId: string, dayId: string) {
    const day = await this.locked(tx, companyId, dayId);
    const status = readDayStatus(day.status) ?? 'planned';
    if (!canArrangeVisits(status)) throw new VanSalesError(`The visits cannot be changed once a day is ${DAY_STATUS_WORDS[status].toLowerCase()}.`);
    return day;
  }

  private async renumber(tx: Tx, dayId: string, order: readonly string[]): Promise<void> {
    for (const [i, vid] of order.entries()) await tx.update(vanVisits).set({ sequence: i + 1, updatedAt: new Date() }).where(and(eq(vanVisits.id, vid), eq(vanVisits.dayId, dayId)));
  }

  private async order(tx: Tx, dayId: string): Promise<string[]> {
    const rows = await tx.select({ id: vanVisits.id }).from(vanVisits).where(eq(vanVisits.dayId, dayId)).orderBy(asc(vanVisits.sequence), asc(vanVisits.id));
    return rows.map((r) => r.id);
  }

  /** Adds a customer who is not on the route's list for this date to the day's visits, at the end. */
  async addVisit(companyId: string, actor: Actor, dayId: string, customerId: unknown): Promise<DayDetail> {
    if (!isId(customerId)) throw new VanSalesError('Choose the customer from the list.');
    await this.db
      .transaction(async (tx) => {
        const day = await this.arrangeable(tx, companyId, dayId);
        const [customer] = await tx.select({ name: customers.name, isActive: customers.isActive, isWalkIn: customers.isWalkIn }).from(customers).where(and(eq(customers.id, customerId), eq(customers.companyId, companyId))).limit(1);
        if (customer?.isActive !== true) throw new VanSalesError('Choose a customer who is in use.');
        if (customer.isWalkIn) throw new VanSalesError('The walk-in customer is whoever walks up to a counter, so it cannot be a visit.');
        const [last] = await tx.select({ n: sql<number>`COALESCE(MAX(${vanVisits.sequence}), 0)::int` }).from(vanVisits).where(eq(vanVisits.dayId, day.id));
        await tx.insert(vanVisits).values({ companyId, dayId: day.id, customerId, sequence: (last?.n ?? 0) + 1 });
        await tx.update(vanDays).set({ version: day.version + 1, updatedAt: new Date() }).where(eq(vanDays.id, day.id));
        await this.record(tx, companyId, day.id, actor, 'day.visit_added', { detail: { customer: customer.name, customerId } });
      })
      .catch(refuse);
    return await this.mustFind(companyId, dayId);
  }

  /** Takes a customer who has not been visited off the day's visits; the rest close up. */
  async removeVisit(companyId: string, actor: Actor, dayId: string, visitId: string): Promise<DayDetail> {
    if (!isId(visitId)) throw new VanSalesError('That visit could not be found.');
    await this.db.transaction(async (tx) => {
      const day = await this.arrangeable(tx, companyId, dayId);
      const [visit] = await tx.select({ v: vanVisits, name: customers.name }).from(vanVisits).innerJoin(customers, eq(customers.id, vanVisits.customerId)).where(and(eq(vanVisits.id, visitId), eq(vanVisits.dayId, day.id))).limit(1).for('update', { of: vanVisits });
      if (visit === undefined) throw new VanSalesError('That customer is no longer on this day\'s visits. Reload the page.');
      if (visit.v.status !== 'planned') throw new VanSalesError('That visit has already started, so it cannot be taken off.');
      await tx.delete(vanVisits).where(eq(vanVisits.id, visit.v.id));
      await this.renumber(tx, day.id, await this.order(tx, day.id));
      await tx.update(vanDays).set({ version: day.version + 1, updatedAt: new Date() }).where(eq(vanDays.id, day.id));
      await this.record(tx, companyId, day.id, actor, 'day.visit_removed', { detail: { customer: visit.name, customerId: visit.v.customerId } });
    });
    return await this.mustFind(companyId, dayId);
  }

  /** Moves a visit one place up or down. */
  async moveVisit(companyId: string, actor: Actor, dayId: string, visitId: string, by: unknown): Promise<DayDetail> {
    if (by !== -1 && by !== 1) throw new VanSalesError('Move a visit up or down one place.');
    if (!isId(visitId)) throw new VanSalesError('That visit could not be found.');
    await this.db.transaction(async (tx) => {
      const day = await this.arrangeable(tx, companyId, dayId);
      const current = await this.order(tx, day.id);
      const next = movedOrder(current, visitId, by);
      if (next === null) throw new VanSalesError(this.cannotMove(current.includes(visitId), by));
      await this.renumber(tx, day.id, next);
      await tx.update(vanDays).set({ version: day.version + 1, updatedAt: new Date() }).where(eq(vanDays.id, day.id));
      await this.record(tx, companyId, day.id, actor, 'day.visits_ordered', { detail: { order: next } });
    });
    return await this.mustFind(companyId, dayId);
  }

  private async mustFind(companyId: string, id: string): Promise<DayDetail> {
    const found = await this.find(companyId, id);
    if (found === null) throw new VanSalesError('That day could not be found.');
    return found;
  }

  /** Why a visit cannot be moved that way, in words. */
  private cannotMove(onTheDay: boolean, by: -1 | 1): string {
    if (!onTheDay) return 'That customer is no longer on this day\'s visits. Reload the page.';
    return by === -1 ? 'That visit is already first.' : 'That visit is already last.';
  }
}

