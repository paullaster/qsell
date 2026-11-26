'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { runSetting, SettingsError } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { VanSalesError } from './errors';
import type { RepView } from './reps';
import type { DayDetail, DayView } from './days';
import type { LoadView, OnVanRow, Suggestion } from './loads';
import type { DaySales, OrderTakenView, TenderChoice, VanSaleView } from './sales';
import type { DropView } from './drops';
import type { CashView } from './cash';
import type { CollectionView, OwingView } from './collections';
import { goOutProblem } from '@/lib/van-sales/run';
import type { ParView, RouteView, StopView } from './routes';
import type { VanView } from './vans';
import { VAN_SALES_DEFAULTS, type VanSalesSettings } from '@/lib/van-sales/settings';

const friendly = (error: unknown): string | null => (error instanceof VanSalesError || error instanceof ReasonError ? error.message : null);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const PATHS = ['/admin/van-sales', '/admin/van-sales/vans', '/admin/van-sales/reps', '/admin/van-sales/routes', '/admin/van-sales/days'];

export interface VanSalesOverview {
  settings: VanSalesSettings;
  vans: { active: number; stopped: number };
  reps: { active: number; paused: number; ended: number };
  routes: { active: number; stopped: number };
  days: { open: number; today: number };
  canManage: boolean;
  canSettings: boolean;
}

/** The van sales home: which modes are on, and how many vans and reps there are. */
export async function vanSalesOverviewAction() {
  return await runSetting(
    'van_sales:read',
    async ({ companyId }): Promise<VanSalesOverview> => {
      const c = getContainer();
      const [settings, vans, reps, routes, days, canManage, canSettings] = await Promise.all([c.vanSalesSettings.current(companyId), c.vans.counts(companyId), c.salesReps.counts(companyId), c.salesRoutes.counts(companyId), c.vanDays.counts(companyId), canPermission('van_sales:manage'), canPermission('van_sales:settings')]);
      return { settings: { ...VAN_SALES_DEFAULTS, ...settings }, vans, reps, routes, days, canManage, canSettings };
    },
    { friendly },
  );
}

// ── Vans ─────────────────────────────────────────────────────────────────

export interface VansPage {
  rows: VanView[];
  nextCursor: string | null;
  canManage: boolean;
}

export async function vansPageAction(raw: unknown) {
  return await runSetting(
    'van_sales:read',
    async ({ companyId }): Promise<VansPage> => {
      const i = obj(raw);
      const status = i.status === 'stopped' || i.status === 'all' ? i.status : 'active';
      const page = await getContainer().vans.page(companyId, { query: text(i.query), cursor: typeof i.cursor === 'string' ? i.cursor : null, status });
      return { ...page, canManage: await canPermission('van_sales:manage') };
    },
    { friendly },
  );
}

export async function createVanAction(raw: unknown) {
  return await runSetting('van_sales:manage', async ({ companyId, userId }): Promise<VanView> => await getContainer().vans.create(companyId, { type: 'user', id: userId }, raw), { paths: PATHS, friendly });
}

export async function updateVanAction(raw: unknown) {
  return await runSetting(
    'van_sales:manage',
    async ({ companyId, userId }): Promise<VanView> => {
      const i = obj(raw);
      return await getContainer().vans.update(companyId, { type: 'user', id: userId }, text(i.id) ?? '', i, i.expectedVersion);
    },
    { paths: PATHS, friendly },
  );
}

export async function setVanActiveAction(raw: unknown) {
  return await runSetting(
    'van_sales:manage',
    async ({ companyId, userId }): Promise<VanView> => {
      const i = obj(raw);
      return await getContainer().vans.setActive(companyId, { type: 'user', id: userId }, text(i.id) ?? '', { active: i.active === true, reason: i.reason, expectedVersion: i.expectedVersion });
    },
    { paths: PATHS, friendly },
  );
}

// ── Reps ─────────────────────────────────────────────────────────────────

export interface RepsPage {
  rows: RepView[];
  nextCursor: string | null;
  canManage: boolean;
}

export async function repsPageAction(raw: unknown) {
  return await runSetting(
    'van_sales:read',
    async ({ companyId }): Promise<RepsPage> => {
      const i = obj(raw);
      const status = i.status === 'paused' || i.status === 'ended' || i.status === 'all' ? i.status : 'active';
      const page = await getContainer().salesReps.page(companyId, { query: text(i.query), cursor: typeof i.cursor === 'string' ? i.cursor : null, status });
      return { ...page, canManage: await canPermission('van_sales:manage') };
    },
    { friendly },
  );
}

export async function createRepAction(raw: unknown) {
  return await runSetting('van_sales:manage', async ({ companyId, userId }): Promise<RepView> => await getContainer().salesReps.create(companyId, { type: 'user', id: userId }, raw), { paths: PATHS, friendly });
}

export async function updateRepAction(raw: unknown) {
  return await runSetting(
    'van_sales:manage',
    async ({ companyId, userId }): Promise<RepView> => {
      const i = obj(raw);
      return await getContainer().salesReps.update(companyId, { type: 'user', id: userId }, text(i.id) ?? '', i, i.expectedVersion);
    },
    { paths: PATHS, friendly },
  );
}

export async function setRepStatusAction(raw: unknown) {
  return await runSetting(
    'van_sales:manage',
    async ({ companyId, userId }): Promise<RepView> => {
      const i = obj(raw);
      return await getContainer().salesReps.setStatus(companyId, { type: 'user', id: userId }, text(i.id) ?? '', { status: i.status, reason: i.reason, expectedVersion: i.expectedVersion });
    },
    { paths: PATHS, friendly },
  );
}

// ── Routes ───────────────────────────────────────────────────────────────

export interface RoutesPage {
  rows: RouteView[];
  nextCursor: string | null;
  canManage: boolean;
  /** Which modes the company has switched on, so a route is offered only the modes it may be in. */
  modes: { vanSell: boolean; preSell: boolean };
}

export async function routesPageAction(raw: unknown) {
  return await runSetting(
    'van_sales:read',
    async ({ companyId }): Promise<RoutesPage> => {
      const i = obj(raw);
      const status = i.status === 'stopped' || i.status === 'all' ? i.status : 'active';
      const c = getContainer();
      const [page, settings, canManage] = await Promise.all([c.salesRoutes.page(companyId, { query: text(i.query), cursor: typeof i.cursor === 'string' ? i.cursor : null, status }), c.vanSalesSettings.current(companyId), canPermission('van_sales:manage')]);
      return { ...page, canManage, modes: { vanSell: settings.vanSell, preSell: settings.preSell } };
    },
    { friendly },
  );
}

export async function createRouteAction(raw: unknown) {
  return await runSetting('van_sales:manage', async ({ companyId, userId }): Promise<RouteView> => await getContainer().salesRoutes.create(companyId, { type: 'user', id: userId }, raw), { paths: PATHS, friendly });
}

/** Everything the route screen shows: the route, its customers in order, and the usual stock of its van. */
export interface RouteScreen {
  route: RouteView;
  stops: StopView[];
  par: ParView[];
  canManage: boolean;
  modes: { vanSell: boolean; preSell: boolean };
}

async function routeScreen(companyId: string, id: string): Promise<RouteScreen> {
  const c = getContainer();
  const route = await c.salesRoutes.find(companyId, id);
  if (route === null) throw new SettingsError('That route could not be found.', 'NOT_FOUND');
  const [stops, par, settings, canManage] = await Promise.all([c.salesRoutes.stops(companyId, route.id), c.salesRoutes.par(companyId, route.id), c.vanSalesSettings.current(companyId), canPermission('van_sales:manage')]);
  return { route, stops, par, canManage, modes: { vanSell: settings.vanSell, preSell: settings.preSell } };
}

export async function routeScreenAction(id: unknown) {
  return await runSetting('van_sales:read', async ({ companyId }): Promise<RouteScreen> => await routeScreen(companyId, typeof id === 'string' ? id : ''), { friendly });
}

/** Runs one change to a route and answers with the refreshed route screen. */
const changeRoute = async (permission: 'van_sales:manage', id: unknown, change: (c: ReturnType<typeof getContainer>, companyId: string, actor: { type: 'user'; id: string }, routeId: string) => Promise<unknown>) =>
  await runSetting(
    permission,
    async ({ companyId, userId }): Promise<RouteScreen> => {
      const routeId = typeof id === 'string' ? id : '';
      await change(getContainer(), companyId, { type: 'user', id: userId }, routeId);
      return await routeScreen(companyId, routeId);
    },
    { paths: PATHS, friendly },
  );

export async function updateRouteAction(raw: unknown) {
  const i = obj(raw);
  return await changeRoute('van_sales:manage', i.id, async (c, companyId, actor, routeId) => await c.salesRoutes.update(companyId, actor, routeId, i, i.expectedVersion));
}

export async function setRouteActiveAction(raw: unknown) {
  const i = obj(raw);
  return await changeRoute('van_sales:manage', i.id, async (c, companyId, actor, routeId) => await c.salesRoutes.setActive(companyId, actor, routeId, { active: i.active === true, reason: i.reason, expectedVersion: i.expectedVersion }));
}

export async function addStopAction(raw: unknown) {
  const i = obj(raw);
  return await changeRoute('van_sales:manage', i.routeId, async (c, companyId, actor, routeId) => await c.salesRoutes.addStop(companyId, actor, routeId, i));
}

export async function updateStopAction(raw: unknown) {
  const i = obj(raw);
  return await changeRoute('van_sales:manage', i.routeId, async (c, companyId, actor) => await c.salesRoutes.updateStop(companyId, actor, text(i.id) ?? '', i, i.expectedVersion));
}

export async function removeStopAction(raw: unknown) {
  const i = obj(raw);
  return await changeRoute('van_sales:manage', i.routeId, async (c, companyId, actor) => await c.salesRoutes.removeStop(companyId, actor, text(i.id) ?? '', i.expectedVersion));
}

export async function moveStopAction(raw: unknown) {
  const i = obj(raw);
  return await changeRoute('van_sales:manage', i.routeId, async (c, companyId, actor, routeId) => await c.salesRoutes.moveStop(companyId, actor, routeId, text(i.id) ?? '', i.by));
}

export async function setParAction(raw: unknown) {
  const i = obj(raw);
  return await changeRoute('van_sales:manage', i.routeId, async (c, companyId, actor, routeId) => await c.salesRoutes.setPar(companyId, actor, routeId, i.lines, i.expectedVersion));
}

/** The customers due on a business date, in the order of the round. */
export async function routeDueAction(raw: unknown) {
  return await runSetting(
    'van_sales:read',
    async ({ companyId }): Promise<StopView[]> => {
      const i = obj(raw);
      return await getContainer().salesRoutes.dueOn(companyId, text(i.routeId) ?? '', i.date);
    },
    { friendly },
  );
}

// ── Van days ─────────────────────────────────────────────────────────────

export interface DaysPage {
  rows: DayView[];
  nextCursor: string | null;
  canPlan: boolean;
  modes: { vanSell: boolean; preSell: boolean };
}

export async function daysPageAction(raw: unknown) {
  return await runSetting(
    'van_sales:read',
    async ({ companyId }): Promise<DaysPage> => {
      const i = obj(raw);
      const status = i.status === 'closed' || i.status === 'cancelled' || i.status === 'all' ? i.status : 'open';
      const c = getContainer();
      const [page, settings, canPlan] = await Promise.all([c.vanDays.page(companyId, { query: text(i.query), cursor: typeof i.cursor === 'string' ? i.cursor : null, status }), c.vanSalesSettings.current(companyId), canPermission('van_sales:plan')]);
      return { ...page, canPlan, modes: { vanSell: settings.vanSell, preSell: settings.preSell } };
    },
    { friendly },
  );
}

/** Plans a day for a route on a date. */
export async function planDayAction(raw: unknown) {
  return await runSetting('van_sales:plan', async ({ companyId, userId }): Promise<DayDetail> => await getContainer().vanDays.plan(companyId, { type: 'user', id: userId }, raw), { paths: PATHS, friendly });
}

export interface DayScreen {
  detail: DayDetail;
  canPlan: boolean;
  /** The loads and top-ups made up for the day, oldest first. */
  loads: LoadView[];
  /** What is on the van now. */
  onVan: OnVanRow[];
  /** What the planner suggests loading, when a load can be made up now. */
  suggestion: Suggestion | null;
  /** The person looking is the day's own rep. */
  isRep: boolean;
  maySell: boolean;
  /** What stops the day going out now, in words; null when it can. */
  outProblem: string | null;
  /** The company lets reps add a customer on the road. */
  offRouteAllowed: boolean;
  /** What the day has sold and how it was paid. */
  sales: DaySales;
  /** The ways the rep can take payment, and what the rep may do alone (only for the rep). */
  tenders: TenderChoice[];
  repLimits: { maxDiscountPercent: number; maxCreditPerDay: number; mayOverridePrice: boolean; maySellOnCredit: boolean } | null;
  /** Set only on the answer to a sale: what was just sold, to show the rep. */
  lastSale?: VanSaleView;
  /** Set only on the answer to an order: what was just taken. */
  lastOrder?: OrderTakenView;
  /** Orders may be taken on this day (the company has pre-sell on and the route takes orders). */
  ordersAllowed: boolean;
  /** The orders to deliver from the van on this day, with where their stock is. */
  drops: DropView[];
  /** What the customers at visits under way owe, and the money collected on the day. */
  owing: OwingView[];
  collections: CollectionView[];
  /** The cash on the van against its limit and the drops made; null when the day has no van till. */
  cash: CashView | null;
  /** The planner may add orders to deliver: a day with a van that takes both kinds of work, before it goes out. */
  canAddDrops: boolean;
}

async function dayScreen(companyId: string, id: string, userId: string): Promise<DayScreen> {
  const c = getContainer();
  const detail = await c.vanDays.find(companyId, id);
  if (detail === null) throw new SettingsError('That day could not be found.', 'NOT_FOUND');
  const day = detail.day;
  const [loads, onVan, canPlan, maySell, rep] = await Promise.all([c.vanLoads.list(companyId, id), c.vanLoads.onVan(companyId, id), canPermission('van_sales:plan'), canPermission('van_sales:sell'), c.salesReps.get(companyId, day.repId)]);
  const wantsLoad = canPlan && day.vanId !== null && (day.status === 'out' || ((day.status === 'planned' || day.status === 'loading') && !loads.some((l) => l.kind === 'load' && l.cancelledAt === null)));
  const suggestion = wantsLoad ? await c.vanLoads.suggest(companyId, id) : null;
  const settings = await c.vanSalesSettings.current(companyId);
  const isRep = rep.userId === userId;
  const selling = day.status === 'out' && isRep && maySell;
  const [sales, tenders, drops, cash, owing, collections] = await Promise.all([c.vanSales.forDay(companyId, id), selling ? c.vanSales.tenderChoices(companyId, day.branchId) : Promise.resolve([]), c.vanDrops.forDay(companyId, id), c.vanCash.forDay(companyId, id), c.vanCollections.owing(companyId, id), c.vanCollections.forDay(companyId, id)]);
  const loadSigned = loads.some((l) => l.kind === 'load' && l.cancelledAt === null && l.signedAt !== null);
  return { detail, canPlan, loads, onVan, suggestion, isRep, maySell, sales, tenders, drops, cash, owing, collections, canAddDrops: canPlan && settings.preSell && day.vanId !== null && day.mode === 'both' && (day.status === 'planned' || day.status === 'loading'), ordersAllowed: settings.preSell && day.mode !== 'van_sell', repLimits: isRep ? { maxDiscountPercent: rep.maxDiscountPercent, maxCreditPerDay: rep.maxCreditPerDay, mayOverridePrice: rep.mayOverridePrice, maySellOnCredit: rep.maySellOnCredit } : null, outProblem: goOutProblem({ status: day.status, mode: day.mode, loadSigned }), offRouteAllowed: settings.offRoute === 'allow' };
}

export async function dayScreenAction(id: unknown) {
  return await runSetting('van_sales:read', async ({ companyId, userId }): Promise<DayScreen> => await dayScreen(companyId, typeof id === 'string' ? id : '', userId), { friendly });
}

const changeDay = async (id: unknown, change: (c: ReturnType<typeof getContainer>, companyId: string, actor: { type: 'user'; id: string }, dayId: string) => Promise<unknown>) =>
  await runSetting(
    'van_sales:plan',
    async ({ companyId, userId }): Promise<DayScreen> => {
      const dayId = typeof id === 'string' ? id : '';
      await change(getContainer(), companyId, { type: 'user', id: userId }, dayId);
      return await dayScreen(companyId, dayId, userId);
    },
    { paths: PATHS, friendly },
  );

export async function cancelDayAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.id, async (c, companyId, actor, dayId) => await c.vanDays.cancel(companyId, actor, dayId, { reason: i.reason, expectedVersion: i.expectedVersion }));
}

export async function addVisitAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.dayId, async (c, companyId, actor, dayId) => await c.vanDays.addVisit(companyId, actor, dayId, i.customerId));
}

export async function removeVisitAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.dayId, async (c, companyId, actor, dayId) => await c.vanDays.removeVisit(companyId, actor, dayId, text(i.id) ?? ''));
}

export async function moveVisitAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.dayId, async (c, companyId, actor, dayId) => await c.vanDays.moveVisit(companyId, actor, dayId, text(i.id) ?? '', i.by));
}

// ── Loading ──────────────────────────────────────────────────────────────

/** What the planner suggests loading, from a chosen warehouse. */
export async function loadSuggestAction(raw: unknown) {
  const i = obj(raw);
  return await runSetting('van_sales:plan', async ({ companyId }): Promise<Suggestion> => await getContainer().vanLoads.suggest(companyId, text(i.dayId) ?? '', i.fromLocationId), { friendly });
}

export async function createLoadAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.dayId, async (c, companyId, actor, dayId) => await c.vanLoads.create(companyId, actor, dayId, i));
}

export async function approveLoadAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.dayId, async (c, companyId, actor) => await c.vanLoads.approve(companyId, actor, text(i.id) ?? ''));
}

export async function shipLoadAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.dayId, async (c, companyId, actor) => await c.vanLoads.ship(companyId, actor, text(i.id) ?? ''));
}

export async function cancelLoadAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.dayId, async (c, companyId, actor) => await c.vanLoads.cancel(companyId, actor, text(i.id) ?? '', i.reason));
}

/** The rep signs for the load; the office may sign for them with a reason. Who may is decided by the service from who is signed in. */
export async function signLoadAction(raw: unknown) {
  const i = obj(raw);
  return await runSetting(
    'van_sales:read',
    async ({ companyId, userId }): Promise<DayScreen> => {
      const dayId = typeof i.dayId === 'string' ? i.dayId : '';
      const [maySell, mayPlan] = await Promise.all([canPermission('van_sales:sell'), canPermission('van_sales:plan')]);
      await getContainer().vanLoads.sign(companyId, { type: 'user', id: userId }, text(i.id) ?? '', i, { maySell, mayPlan });
      return await dayScreen(companyId, dayId, userId);
    },
    { paths: PATHS, friendly },
  );
}

// ── Running the day (the rep's own) ──────────────────────────────────────

/** Runs one step of the rep's own day: who may is decided by the service from who is signed in. */
const runDay = async (id: unknown, step: (c: ReturnType<typeof getContainer>, companyId: string, actor: { type: 'user'; id: string }, dayId: string, maySell: boolean) => Promise<unknown>) =>
  await runSetting(
    'van_sales:read',
    async ({ companyId, userId }): Promise<DayScreen> => {
      const dayId = typeof id === 'string' ? id : '';
      await step(getContainer(), companyId, { type: 'user', id: userId }, dayId, await canPermission('van_sales:sell'));
      return await dayScreen(companyId, dayId, userId);
    },
    { paths: PATHS, friendly },
  );

/** The rep sends the day out, counting the float into the van's till. */
export async function sendOutAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanRun.sendOut(companyId, actor, dayId, i, maySell));
}

export async function arriveAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanRun.arrive(companyId, actor, dayId, text(i.id) ?? '', i, maySell));
}

export async function finishVisitAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanRun.finish(companyId, actor, dayId, text(i.id) ?? '', i, maySell));
}

export async function skipVisitAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanRun.skip(companyId, actor, dayId, text(i.id) ?? '', i.reason, maySell));
}

export async function closedShopAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanRun.closedShop(companyId, actor, dayId, text(i.id) ?? '', i.reason, maySell));
}

export async function addOnRouteAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanRun.addOnRoute(companyId, actor, dayId, i.customerId, maySell));
}

// ── Selling (the rep's own) ──────────────────────────────────────────────

export interface PricedSale {
  subtotal: number;
  tax: number;
  total: number;
  lines: { productId: string; quantity: number; unitPrice: number; lineTotal: number }[];
}

/** What the lines would total for the customer at this visit, priced by the server as the sale will be. Saves nothing. */
export async function priceVanSaleAction(raw: unknown) {
  const i = obj(raw);
  return await runSetting(
    'van_sales:read',
    async ({ companyId, userId }): Promise<PricedSale> => {
      const priced = await getContainer().vanSales.price(companyId, { type: 'user', id: userId }, text(i.dayId) ?? '', i, await canPermission('van_sales:sell'));
      return { subtotal: priced.subtotal, tax: priced.tax, total: priced.total, lines: priced.lines };
    },
    { friendly },
  );
}

/** Sells at a visit, paid now or on the customer's account. Answers with the day and what was sold. */
export async function sellVanAction(raw: unknown) {
  const i = obj(raw);
  return await runSetting(
    'van_sales:read',
    async ({ companyId, userId }): Promise<DayScreen> => {
      const dayId = typeof i.dayId === 'string' ? i.dayId : '';
      const sale = await getContainer().vanSales.sell(companyId, { type: 'user', id: userId }, dayId, i, await canPermission('van_sales:sell'));
      return { ...(await dayScreen(companyId, dayId, userId)), lastSale: sale };
    },
    { paths: PATHS, friendly },
  );
}

/** Takes an order at a visit, for delivery later. Answers with the day and the order taken. */
export async function takeOrderAction(raw: unknown) {
  const i = obj(raw);
  return await runSetting(
    'van_sales:read',
    async ({ companyId, userId }): Promise<DayScreen> => {
      const dayId = typeof i.dayId === 'string' ? i.dayId : '';
      const order = await getContainer().vanSales.order(companyId, { type: 'user', id: userId }, dayId, i, await canPermission('van_sales:sell'));
      return { ...(await dayScreen(companyId, dayId, userId)), lastOrder: order };
    },
    { paths: PATHS, friendly },
  );
}

// ── Deliveries from the van ──────────────────────────────────────────────

/** The planner adds an order to the day's deliveries. */
export async function addDropAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.dayId, async (c, companyId, actor, dayId) => await c.vanDrops.add(companyId, actor, dayId, typeof i.orderId === 'string' ? i.orderId : ''));
}

/** The planner takes a delivery off the day, while its stock has not left the warehouse. */
export async function removeDropAction(raw: unknown) {
  const i = obj(raw);
  return await changeDay(i.dayId, async (c, companyId, actor, dayId) => await c.vanDrops.remove(companyId, actor, dayId, text(i.id) ?? ''));
}

/** The rep delivers the order to the customer they are at. */
export async function deliverDropAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanDrops.deliver(companyId, actor, dayId, text(i.id) ?? '', i, maySell));
}

/** The rep closes a delivery that was refused or could not be made, with the reason. */
export async function closeDropAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanDrops.close(companyId, actor, dayId, text(i.id) ?? '', i.state === 'refused' ? 'refused' : 'failed', i.reason, maySell));
}

/** The rep takes cash off the van to the safe, a bank run or the office. */
export async function cashDropAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanCash.drop(companyId, actor, dayId, i, maySell));
}

/** The rep collects money from the customer they are at, against what they owe. */
export async function collectAction(raw: unknown) {
  const i = obj(raw);
  return await runDay(i.dayId, async (c, companyId, actor, dayId, maySell) => await c.vanCollections.collect(companyId, actor, dayId, i, maySell));
}
