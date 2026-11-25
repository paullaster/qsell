'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { runSetting, SettingsError } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { VanSalesError } from './errors';
import type { RepView } from './reps';
import type { DayDetail, DayView } from './days';
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
}

async function dayScreen(companyId: string, id: string): Promise<DayScreen> {
  const detail = await getContainer().vanDays.find(companyId, id);
  if (detail === null) throw new SettingsError('That day could not be found.', 'NOT_FOUND');
  return { detail, canPlan: await canPermission('van_sales:plan') };
}

export async function dayScreenAction(id: unknown) {
  return await runSetting('van_sales:read', async ({ companyId }): Promise<DayScreen> => await dayScreen(companyId, typeof id === 'string' ? id : ''), { friendly });
}

const changeDay = async (id: unknown, change: (c: ReturnType<typeof getContainer>, companyId: string, actor: { type: 'user'; id: string }, dayId: string) => Promise<unknown>) =>
  await runSetting(
    'van_sales:plan',
    async ({ companyId, userId }): Promise<DayScreen> => {
      const dayId = typeof id === 'string' ? id : '';
      await change(getContainer(), companyId, { type: 'user', id: userId }, dayId);
      return await dayScreen(companyId, dayId);
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
