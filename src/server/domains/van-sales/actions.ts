'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { VanSalesError } from './errors';
import type { RepView } from './reps';
import type { VanView } from './vans';
import { VAN_SALES_DEFAULTS, type VanSalesSettings } from '@/lib/van-sales/settings';

const friendly = (error: unknown): string | null => (error instanceof VanSalesError || error instanceof ReasonError ? error.message : null);
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const PATHS = ['/admin/van-sales', '/admin/van-sales/vans', '/admin/van-sales/reps'];

export interface VanSalesOverview {
  settings: VanSalesSettings;
  vans: { active: number; stopped: number };
  reps: { active: number; paused: number; ended: number };
  canManage: boolean;
  canSettings: boolean;
}

/** The van sales home: which modes are on, and how many vans and reps there are. */
export async function vanSalesOverviewAction() {
  return await runSetting(
    'van_sales:read',
    async ({ companyId }): Promise<VanSalesOverview> => {
      const c = getContainer();
      const [settings, vans, reps, canManage, canSettings] = await Promise.all([c.vanSalesSettings.current(companyId), c.vans.counts(companyId), c.salesReps.counts(companyId), canPermission('van_sales:manage'), canPermission('van_sales:settings')]);
      return { settings: { ...VAN_SALES_DEFAULTS, ...settings }, vans, reps, canManage, canSettings };
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
