import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { branches, customers, products, routeParLevels, routeStops, salesReps, salesRoutes, unitsOfMeasure, vans } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import { isId, readReason } from '@/lib/van-sales/people';
import { movedOrder, readOrder, readPar, readRoute, readStop, vanProblem, type RouteInput } from '@/lib/van-sales/routes';
import { modesNeeded, routeModeProblem, type RouteMode } from '@/lib/van-sales/settings';
import { dayNumber, dueStops, weekdayWords, type EveryWeeks } from '@/lib/van-sales/visits';
import { quantityProblem } from '@/lib/unit-rules';
import { afterCursor, matching, PAGE_SIZE, pageOf, searchText, type PageInput } from '@/server/domains/settings/paging';
import { constraintOf, VanSalesError } from './errors';
import { openDayOf, openDayWords } from './open-days';
import type { VanSalesSettingsService } from './settings-service';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

export interface RouteView {
  id: string;
  code: string;
  name: string;
  branchId: string;
  branchName: string;
  mode: RouteMode;
  defaultVanId: string | null;
  defaultVanName: string | null;
  defaultRepId: string | null;
  defaultRepName: string | null;
  status: 'active' | 'stopped';
  statusReason: string | null;
  version: number;
  stops: number;
  parLines: number;
}

export interface StopView {
  id: string;
  customerId: string;
  customerName: string;
  customerPhone: string | null;
  customerPlace: string | null;
  /** The customer cannot be sold to (blocked) or is no longer in use: shown so the office sees it before the rep does. */
  customerWarning: string | null;
  sequence: number;
  visitDays: number;
  visitWords: string;
  every: EveryWeeks;
  anchor: string;
  note: string | null;
  version: number;
}

export interface ParView {
  productId: string;
  productName: string;
  sku: string;
  unitName: string;
  decimals: number;
  quantity: number;
}

export type RouteFilter = 'active' | 'stopped' | 'all';
export interface RoutePageInput extends PageInput {
  status?: RouteFilter;
}

const TAKEN: Record<string, string> = {
  sales_routes_company_code_uidx: 'A route with that code already exists. Give it a different code.',
  sales_routes_company_name_uidx: 'A route with that name already exists. Give it a different name.',
  route_stops_route_customer_uidx: 'That customer is already on this route.',
};
const refuse = (error: unknown): never => {
  const known = TAKEN[constraintOf(error) ?? ''];
  if (known !== undefined) throw new VanSalesError(known);
  throw error;
};

const modeOf = (value: string): RouteMode => (value === 'van_sell' || value === 'pre_sell' ? value : 'both');
const everyOf = (n: number): EveryWeeks => (n === 2 || n === 4 ? n : 1);
export const customerWarning = (c: { isActive: boolean; blocked: string }): string | null => {
  if (!c.isActive) return 'This customer is no longer in use.';
  return c.blocked === 'all' || c.blocked === 'invoice' ? 'This customer is blocked from being sold to.' : null;
};

/**
 * Routes (docs/architecture/van-sales.md §4.2, §6): a named round of customers, each with the days and how often they are visited and a
 * place in the round, and the stock a van should start the day with. A route and its stops are stopped and taken off, never deleted, so a
 * day that ran on them keeps them. Every change is under a version, serialised on the route, and in the decision log.
 */
export class RouteService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly settings: VanSalesSettingsService,
  ) {}

  // ── Routes ───────────────────────────────────────────────────────────

  private select() {
    return this.db
      .select({
        r: salesRoutes,
        branchName: branches.name,
        vanName: vans.name,
        repName: salesReps.name,
        stops: sql<number>`(SELECT count(*)::int FROM ${routeStops} s WHERE s.route_id = ${salesRoutes.id} AND s.active)`,
        parLines: sql<number>`(SELECT count(*)::int FROM ${routeParLevels} p WHERE p.route_id = ${salesRoutes.id})`,
      })
      .from(salesRoutes)
      .innerJoin(branches, eq(branches.id, salesRoutes.branchId))
      .leftJoin(vans, eq(vans.id, salesRoutes.defaultVanId))
      .leftJoin(salesReps, eq(salesReps.id, salesRoutes.defaultRepId));
  }

  private view(x: Awaited<ReturnType<RouteService['select']>>[number]): RouteView {
    const r = x.r;
    return {
      id: r.id,
      code: r.code,
      name: r.name,
      branchId: r.branchId,
      branchName: x.branchName,
      mode: modeOf(r.mode),
      defaultVanId: r.defaultVanId,
      defaultVanName: x.vanName,
      defaultRepId: r.defaultRepId,
      defaultRepName: x.repName,
      status: r.status === 'stopped' ? 'stopped' : 'active',
      statusReason: r.statusReason,
      version: r.version,
      stops: x.stops,
      parLines: x.parLines,
    };
  }

  async page(companyId: string, input: RoutePageInput): Promise<{ rows: RouteView[]; nextCursor: string | null }> {
    const status = input.status ?? 'active';
    const rows = await this.select()
      .where(and(eq(salesRoutes.companyId, companyId), status === 'all' ? undefined : eq(salesRoutes.status, status), matching(searchText(input), [salesRoutes.name, salesRoutes.code]), afterCursor(input.cursor, salesRoutes.name, salesRoutes.id)))
      .orderBy(asc(salesRoutes.name), asc(salesRoutes.id))
      .limit(PAGE_SIZE + 1);
    const page = pageOf(rows, PAGE_SIZE, (x) => ({ k: x.r.name, id: x.r.id }));
    return { rows: page.rows.map((x) => this.view(x)), nextCursor: page.nextCursor };
  }

  async get(companyId: string, id: string): Promise<RouteView> {
    if (!isId(id)) throw new VanSalesError('That route could not be found.');
    const [row] = await this.select().where(and(eq(salesRoutes.companyId, companyId), eq(salesRoutes.id, id))).limit(1);
    if (row === undefined) throw new VanSalesError('That route could not be found.');
    return this.view(row);
  }

  /** The route, or null when there is none like it (a malformed id counts as none). */
  async find(companyId: string, id: string): Promise<RouteView | null> {
    if (!isId(id)) return null;
    const [row] = await this.select().where(and(eq(salesRoutes.companyId, companyId), eq(salesRoutes.id, id))).limit(1);
    return row === undefined ? null : this.view(row);
  }

  async counts(companyId: string): Promise<{ active: number; stopped: number }> {
    const rows = await this.db.select({ status: salesRoutes.status, n: sql<number>`count(*)::int` }).from(salesRoutes).where(eq(salesRoutes.companyId, companyId)).groupBy(salesRoutes.status);
    return { active: rows.find((r) => r.status === 'active')?.n ?? 0, stopped: rows.find((r) => r.status === 'stopped')?.n ?? 0 };
  }

  /** The branch, van and rep must be the company's, in use, and fit the route: the van in the route's branch, the rep doing what the route needs. */
  private async checkParts(tx: Tx, companyId: string, route: RouteInput): Promise<void> {
    const [branch] = await tx.select({ id: branches.id }).from(branches).where(and(eq(branches.id, route.branchId), eq(branches.companyId, companyId), eq(branches.isActive, true))).limit(1);
    if (branch === undefined) throw new VanSalesError('Choose one of the company\'s branches that is in use.');
    const noVan = vanProblem(route.mode, route.defaultVanId);
    if (noVan !== null) throw new VanSalesError(noVan);
    if (route.defaultVanId !== null) {
      const [van] = await tx.select({ branchId: vans.branchId, status: vans.status, name: vans.name }).from(vans).where(and(eq(vans.id, route.defaultVanId), eq(vans.companyId, companyId))).limit(1);
      if (van?.status !== 'active') throw new VanSalesError('Choose one of the company\'s vans that is in use.');
      if (van.branchId !== route.branchId) throw new VanSalesError(`The van ${van.name} belongs to another branch than the route's. Choose a van from the route's branch.`);
    }
    if (route.defaultRepId !== null) {
      const [rep] = await tx.select({ status: salesReps.status, modes: salesReps.modes, name: salesReps.name }).from(salesReps).where(and(eq(salesReps.id, route.defaultRepId), eq(salesReps.companyId, companyId))).limit(1);
      if (rep?.status !== 'active') throw new VanSalesError('Choose a sales rep who is selling.');
      const lacks = modesNeeded(route.mode).map((m) => (m === 'vanSell' ? 'van_sell' : 'pre_sell')).filter((m) => !rep.modes.includes(m));
      if (lacks.length > 0) throw new VanSalesError(`${rep.name} does not do ${lacks.map((m) => (m === 'van_sell' ? 'van sell' : 'pre-sell')).join(' or ')}, which this route needs. Change what the rep does, or choose another rep.`);
    }
  }

  async create(companyId: string, actor: Actor, raw: unknown): Promise<RouteView> {
    const read = readRoute(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const route = read.route;
    const modeProblem = routeModeProblem(await this.settings.current(companyId), route.mode);
    if (modeProblem !== null) throw new VanSalesError(modeProblem);
    const id = await this.db
      .transaction(async (tx) => {
        await this.checkParts(tx, companyId, route);
        const [made] = await tx
          .insert(salesRoutes)
          .values({ companyId, code: route.code, name: route.name, branchId: route.branchId, mode: route.mode, defaultVanId: route.defaultVanId, defaultRepId: route.defaultRepId, createdBy: actor.id ?? 'system' })
          .returning({ id: salesRoutes.id });
        if (made === undefined) throw new VanSalesError('The route could not be saved. Please try again.');
        await this.decisions.record({ companyId, actor, subject: { type: 'sales_route', id: made.id }, action: 'route.created', reason: { text: route.name }, inputs: {}, outcome: { ...route } }, tx);
        return made.id;
      })
      .catch(refuse);
    return await this.get(companyId, id);
  }

  private async locked(tx: Tx, companyId: string, id: string, expectedVersion?: unknown) {
    if (!isId(id)) throw new VanSalesError('That route could not be found.');
    const [row] = await tx.select().from(salesRoutes).where(and(eq(salesRoutes.companyId, companyId), eq(salesRoutes.id, id))).limit(1).for('update');
    if (row === undefined) throw new VanSalesError('That route could not be found.');
    if (expectedVersion !== undefined && expectedVersion !== row.version) throw new VanSalesError('Someone else changed this route while you were looking at it. Reload the page to see the latest.');
    return row;
  }

  async update(companyId: string, actor: Actor, id: string, raw: unknown, expectedVersion: unknown): Promise<RouteView> {
    const read = readRoute(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const route = read.route;
    const modeProblem = routeModeProblem(await this.settings.current(companyId), route.mode);
    if (modeProblem !== null) throw new VanSalesError(modeProblem);
    await this.db
      .transaction(async (tx) => {
        const row = await this.locked(tx, companyId, id, expectedVersion);
        if (row.status !== 'active') throw new VanSalesError('This route is stopped. Use it again before changing it.');
        if (route.branchId !== row.branchId) throw new VanSalesError('A route stays in its branch. To run it from another branch, add a new route and stop this one.');
        await this.checkParts(tx, companyId, route);
        await tx.update(salesRoutes).set({ code: route.code, name: route.name, mode: route.mode, defaultVanId: route.defaultVanId, defaultRepId: route.defaultRepId, version: row.version + 1, updatedAt: new Date() }).where(eq(salesRoutes.id, row.id));
        await this.decisions.record({ companyId, actor, subject: { type: 'sales_route', id: row.id }, action: 'route.changed', reason: { text: route.name }, inputs: { code: row.code, name: row.name, mode: row.mode, defaultVanId: row.defaultVanId, defaultRepId: row.defaultRepId }, outcome: { ...route } }, tx);
      })
      .catch(refuse);
    return await this.get(companyId, id);
  }

  /** Stops a route (with a reason) or puts it back in use. */
  async setActive(companyId: string, actor: Actor, id: string, input: { active: boolean; reason?: unknown; expectedVersion: unknown }): Promise<RouteView> {
    const why = input.active ? null : readReason(input.reason);
    if (why !== null && !why.ok) throw new VanSalesError(why.error);
    const settings = await this.settings.current(companyId);
    await this.db.transaction(async (tx) => {
      const row = await this.locked(tx, companyId, id, input.expectedVersion);
      if (input.active === (row.status === 'active')) throw new VanSalesError(input.active ? 'This route is already in use.' : 'This route is already stopped.');
      if (input.active) {
        const modeProblem = routeModeProblem(settings, modeOf(row.mode));
        if (modeProblem !== null) throw new VanSalesError(modeProblem);
        await this.checkParts(tx, companyId, { code: row.code, name: row.name, branchId: row.branchId, mode: modeOf(row.mode), defaultVanId: row.defaultVanId, defaultRepId: row.defaultRepId });
      }
      if (!input.active) {
        const day = await openDayOf(tx, companyId, { routeId: row.id });
        if (day !== null) throw new VanSalesError(openDayWords('This route', day));
      }
      const status = input.active ? 'active' : 'stopped';
      await tx.update(salesRoutes).set({ status, statusReason: why?.reason ?? null, version: row.version + 1, updatedAt: new Date() }).where(eq(salesRoutes.id, row.id));
      await this.decisions.record({ companyId, actor, subject: { type: 'sales_route', id: row.id }, action: input.active ? 'route.resumed' : 'route.stopped', reason: { text: why?.reason ?? row.name }, inputs: { status: row.status }, outcome: { status } }, tx);
    });
    return await this.get(companyId, id);
  }

  // ── Stops ────────────────────────────────────────────────────────────

  private stopView(x: { s: typeof routeStops.$inferSelect; name: string; phone: string | null; city: string | null; isActive: boolean; blocked: string }): StopView {
    return {
      id: x.s.id,
      customerId: x.s.customerId,
      customerName: x.name,
      customerPhone: x.phone,
      customerPlace: x.city,
      customerWarning: customerWarning(x),
      sequence: x.s.sequence,
      visitDays: x.s.visitDays,
      visitWords: `${weekdayWords(x.s.visitDays)}${x.s.everyWeeks === 1 ? '' : `, every ${String(x.s.everyWeeks)} weeks`}`,
      every: everyOf(x.s.everyWeeks),
      anchor: x.s.anchorDate,
      note: x.s.note,
      version: x.s.version,
    };
  }

  /** The customers on a route, in the order of the round. A round is a few dozen customers, so this is one read. */
  async stops(companyId: string, routeId: string): Promise<StopView[]> {
    if (!isId(routeId)) throw new VanSalesError('That route could not be found.');
    const rows = await this.db
      .select({ s: routeStops, name: customers.name, phone: customers.phone, city: customers.city, isActive: customers.isActive, blocked: customers.blocked })
      .from(routeStops)
      .innerJoin(customers, eq(customers.id, routeStops.customerId))
      .where(and(eq(routeStops.companyId, companyId), eq(routeStops.routeId, routeId), eq(routeStops.active, true)))
      .orderBy(asc(routeStops.sequence), asc(routeStops.id))
      .limit(1000);
    return rows.map((r) => this.stopView(r));
  }

  async addStop(companyId: string, actor: Actor, routeId: string, raw: unknown): Promise<StopView[]> {
    const read = readStop(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const stop = read.stop;
    await this.db
      .transaction(async (tx) => {
        const route = await this.locked(tx, companyId, routeId);
        if (route.status !== 'active') throw new VanSalesError('This route is stopped. Use it again before adding customers.');
        const [customer] = await tx.select({ name: customers.name, isActive: customers.isActive, isWalkIn: customers.isWalkIn }).from(customers).where(and(eq(customers.id, stop.customerId), eq(customers.companyId, companyId))).limit(1);
        if (customer?.isActive !== true) throw new VanSalesError('Choose a customer who is in use.');
        if (customer.isWalkIn) throw new VanSalesError('The walk-in customer is whoever walks up to a counter, so it cannot be a stop on a route.');
        const [last] = await tx.select({ n: sql<number>`COALESCE(MAX(${routeStops.sequence}), 0)::int` }).from(routeStops).where(and(eq(routeStops.routeId, route.id), eq(routeStops.active, true)));
        const [made] = await tx
          .insert(routeStops)
          .values({ companyId, routeId: route.id, customerId: stop.customerId, sequence: (last?.n ?? 0) + 1, visitDays: stop.visitDays, everyWeeks: stop.every, anchorDate: stop.anchor, note: stop.note })
          .returning({ id: routeStops.id });
        await this.decisions.record({ companyId, actor, subject: { type: 'sales_route', id: route.id }, action: 'route.stop_added', reason: { text: customer.name }, inputs: {}, outcome: { stopId: made?.id ?? null, customerId: stop.customerId, visitDays: stop.visitDays, every: stop.every } }, tx);
      })
      .catch(refuse);
    return await this.stops(companyId, routeId);
  }

  async updateStop(companyId: string, actor: Actor, stopId: string, raw: unknown, expectedVersion: unknown): Promise<StopView[]> {
    const read = readStop(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    const next = read.stop;
    if (!isId(stopId)) throw new VanSalesError('That stop could not be found.');
    const routeId = await this.db.transaction(async (tx) => {
      const [found] = await tx.select({ routeId: routeStops.routeId }).from(routeStops).where(and(eq(routeStops.id, stopId), eq(routeStops.companyId, companyId))).limit(1);
      if (found === undefined) throw new VanSalesError('That stop could not be found.');
      const route = await this.locked(tx, companyId, found.routeId);
      const [row] = await tx.select().from(routeStops).where(eq(routeStops.id, stopId)).limit(1).for('update');
      if (row?.active !== true) throw new VanSalesError('That customer is no longer on this route. Reload the page.');
      if (expectedVersion !== row.version) throw new VanSalesError('Someone else changed this stop while you were looking at it. Reload the page to see the latest.');
      if (next.customerId !== row.customerId) throw new VanSalesError('A stop keeps its customer. To visit another customer, add them as a new stop.');
      await tx.update(routeStops).set({ visitDays: next.visitDays, everyWeeks: next.every, anchorDate: next.anchor, note: next.note, version: row.version + 1, updatedAt: new Date() }).where(eq(routeStops.id, row.id));
      await this.decisions.record({ companyId, actor, subject: { type: 'sales_route', id: route.id }, action: 'route.stop_changed', reason: { text: route.name }, inputs: { stopId: row.id, visitDays: row.visitDays, every: row.everyWeeks, anchor: row.anchorDate }, outcome: { visitDays: next.visitDays, every: next.every, anchor: next.anchor } }, tx);
      return route.id;
    });
    return await this.stops(companyId, routeId);
  }

  /** Renumbers the active stops of a route 1..n in the order given. The route is locked by the caller. */
  private async renumber(tx: Tx, routeId: string, order: readonly string[]): Promise<void> {
    for (const [i, id] of order.entries()) await tx.update(routeStops).set({ sequence: i + 1, updatedAt: new Date() }).where(and(eq(routeStops.id, id), eq(routeStops.routeId, routeId)));
  }

  private async activeOrder(tx: Tx, routeId: string): Promise<string[]> {
    const rows = await tx.select({ id: routeStops.id }).from(routeStops).where(and(eq(routeStops.routeId, routeId), eq(routeStops.active, true))).orderBy(asc(routeStops.sequence), asc(routeStops.id));
    return rows.map((r) => r.id);
  }

  async removeStop(companyId: string, actor: Actor, stopId: string, expectedVersion: unknown): Promise<StopView[]> {
    if (!isId(stopId)) throw new VanSalesError('That stop could not be found.');
    const routeId = await this.db.transaction(async (tx) => {
      const [found] = await tx.select({ routeId: routeStops.routeId }).from(routeStops).where(and(eq(routeStops.id, stopId), eq(routeStops.companyId, companyId))).limit(1);
      if (found === undefined) throw new VanSalesError('That stop could not be found.');
      const route = await this.locked(tx, companyId, found.routeId);
      const [row] = await tx.select().from(routeStops).where(eq(routeStops.id, stopId)).limit(1).for('update');
      if (row?.active !== true) throw new VanSalesError('That customer is no longer on this route. Reload the page.');
      if (expectedVersion !== row.version) throw new VanSalesError('Someone else changed this stop while you were looking at it. Reload the page to see the latest.');
      await tx.update(routeStops).set({ active: false, version: row.version + 1, updatedAt: new Date() }).where(eq(routeStops.id, row.id));
      await this.renumber(tx, route.id, await this.activeOrder(tx, route.id));
      await this.decisions.record({ companyId, actor, subject: { type: 'sales_route', id: route.id }, action: 'route.stop_removed', reason: { text: route.name }, inputs: { stopId: row.id, customerId: row.customerId }, outcome: {} }, tx);
      return route.id;
    });
    return await this.stops(companyId, routeId);
  }

  /** Puts the route's stops in the order given, which must name every stop on the route once. */
  async reorder(companyId: string, actor: Actor, routeId: string, order: unknown): Promise<StopView[]> {
    await this.db.transaction(async (tx) => {
      const route = await this.locked(tx, companyId, routeId);
      const current = await this.activeOrder(tx, route.id);
      const read = readOrder(order, current);
      if (!read.ok) throw new VanSalesError(read.error);
      await this.renumber(tx, route.id, read.order);
      await this.decisions.record({ companyId, actor, subject: { type: 'sales_route', id: route.id }, action: 'route.stops_ordered', reason: { text: route.name }, inputs: { order: current }, outcome: { order: read.order } }, tx);
    });
    return await this.stops(companyId, routeId);
  }

  /** Moves one stop a place up or down. */
  async moveStop(companyId: string, actor: Actor, routeId: string, stopId: string, by: unknown): Promise<StopView[]> {
    if (by !== -1 && by !== 1) throw new VanSalesError('Move a stop up or down one place.');
    const current = (await this.stops(companyId, routeId)).map((s) => s.id);
    const next = movedOrder(current, stopId, by);
    if (next === null) throw new VanSalesError(by === -1 ? 'That stop is already first.' : 'That stop is already last.');
    return await this.reorder(companyId, actor, routeId, next);
  }

  /** The customers due on a business date, in the order of the round. */
  async dueOn(companyId: string, routeId: string, date: unknown): Promise<StopView[]> {
    if (typeof date !== 'string' || dayNumber(date) === null) throw new VanSalesError('Give a real date, such as 2026-11-30.');
    const all = await this.stops(companyId, routeId);
    const due = dueStops(all.map((s) => ({ ...s, active: true })), date);
    return due.map(({ active: _active, ...s }) => s);
  }

  // ── Usual stock ──────────────────────────────────────────────────────

  async par(companyId: string, routeId: string): Promise<ParView[]> {
    if (!isId(routeId)) throw new VanSalesError('That route could not be found.');
    const rows = await this.db
      .select({ productId: routeParLevels.productId, quantity: routeParLevels.quantity, name: products.name, sku: products.sku, unitName: unitsOfMeasure.name, decimals: unitsOfMeasure.decimals })
      .from(routeParLevels)
      .innerJoin(products, eq(products.id, routeParLevels.productId))
      .leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.baseUnitId))
      .where(and(eq(routeParLevels.companyId, companyId), eq(routeParLevels.routeId, routeId)))
      .orderBy(asc(products.name), asc(routeParLevels.productId))
      .limit(500);
    return rows.map((r) => ({ productId: r.productId, productName: r.name, sku: r.sku, unitName: r.unitName ?? 'unit', decimals: r.decimals ?? 3, quantity: r.quantity }));
  }

  /** Replaces the usual stock of a route with the list given (each product once, a quantity that fits its unit). */
  async setPar(companyId: string, actor: Actor, routeId: string, raw: unknown, expectedVersion: unknown): Promise<ParView[]> {
    const read = readPar(raw);
    if (!read.ok) throw new VanSalesError(read.error);
    await this.db.transaction(async (tx) => {
      const route = await this.locked(tx, companyId, routeId, expectedVersion);
      if (route.status !== 'active') throw new VanSalesError('This route is stopped. Use it again before changing its usual stock.');
      const ids = read.rows.map((r) => r.productId);
      const facts = ids.length === 0 ? [] : await tx.select({ id: products.id, name: products.name, kind: products.inventoryKind, deleted: products.deletedAt, unitName: unitsOfMeasure.name, decimals: unitsOfMeasure.decimals }).from(products).leftJoin(unitsOfMeasure, eq(unitsOfMeasure.id, products.baseUnitId)).where(inArray(products.id, ids));
      for (const line of read.rows) {
        const f = facts.find((x) => x.id === line.productId);
        if (f === undefined) throw new VanSalesError('A product on the list could not be found.');
        if (f.deleted !== null) throw new VanSalesError('A product on the list could not be found.');
        if (f.kind !== 'inventory') throw new VanSalesError(`"${f.name}" is not kept in stock, so a van cannot carry a usual quantity of it.`);
        const problem = quantityProblem(line.quantity, f.decimals ?? 3, f.unitName ?? 'unit', `The quantity of "${f.name}"`);
        if (problem !== null) throw new VanSalesError(problem);
      }
      const before = await tx.select({ productId: routeParLevels.productId, quantity: routeParLevels.quantity }).from(routeParLevels).where(eq(routeParLevels.routeId, route.id));
      if (ids.length === 0) await tx.delete(routeParLevels).where(eq(routeParLevels.routeId, route.id));
      else await tx.delete(routeParLevels).where(and(eq(routeParLevels.routeId, route.id), sql`${routeParLevels.productId} NOT IN (${sql.join(ids.map((i) => sql`${i}`), sql`, `)})`));
      for (const line of read.rows) {
        await tx.insert(routeParLevels).values({ routeId: route.id, productId: line.productId, companyId, quantity: line.quantity }).onConflictDoUpdate({ target: [routeParLevels.routeId, routeParLevels.productId], set: { quantity: line.quantity, updatedAt: new Date() } });
      }
      await tx.update(salesRoutes).set({ version: route.version + 1, updatedAt: new Date() }).where(eq(salesRoutes.id, route.id));
      await this.decisions.record({ companyId, actor, subject: { type: 'sales_route', id: route.id }, action: 'route.par_set', reason: { text: route.name }, inputs: { lines: before.length }, outcome: { lines: read.rows.length } }, tx);
    });
    return await this.par(companyId, routeId);
  }
}
