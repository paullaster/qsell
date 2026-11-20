'use server';

import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { runSetting } from '@/server/domains/settings/action-runner';
import { ReasonError } from '@/server/kernel/reason-codes/service';
import { OfflineError, type IngestResult, type OfflineSnapshot, type ReviewRow } from './offline-sale-service';
import type { OfflineLimits } from './offline-rules';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

/** The till, while online: the key for this shift, the limits, and what it may sell and be paid with, to keep for selling with no connection. */
export async function offlineSnapshotAction(): Promise<{ ok: true; data: OfflineSnapshot } | { ok: false; error: string }> {
  const userId = await requirePermission('cash_sales:create');
  try {
    const c = getContainer();
    return await c.offlineSales.snapshot((await c.companySettings.ensureSeeded()).id, userId);
  } catch (error) {
    console.error('[offline] snapshot', error);
    return { ok: false, error: 'The till could not be made ready for offline selling just now. Please try again.' };
  }
}

/** The till, when the connection is back: takes in one sale rung up offline. Sending it again changes nothing. */
export async function syncOfflineSaleAction(raw: unknown): Promise<IngestResult> {
  const userId = await requirePermission('cash_sales:create');
  try {
    const c = getContainer();
    return await c.offlineSales.ingest((await c.companySettings.ensureSeeded()).id, { userId }, raw);
  } catch (error) {
    console.error('[offline] sync', error);
    return { ok: false, error: 'The sale could not be taken in just now. It is kept on the till: it will be sent again.' };
  }
}

export interface OfflineReviewScreen {
  rows: ReviewRow[];
  canSupervise: boolean;
}

/** Offline sales that need a person: accepted with a difference, parked (stock not there), or refused. */
export async function offlineReviewAction(): Promise<{ ok: true; data: OfflineReviewScreen } | { ok: false; error: string }> {
  await requirePermission('cash_sales:read');
  try {
    const c = getContainer();
    return { ok: true, data: { rows: await c.offlineSales.review((await c.companySettings.ensureSeeded()).id), canSupervise: await canPermission('shifts:supervise') } };
  } catch (error) {
    console.error('[offline] review', error);
    return { ok: false, error: 'The offline sales could not be loaded. Please try again.' };
  }
}

const sale = async (id: unknown, run: (companyId: string, userId: string, id: string) => Promise<IngestResult | { ok: true } | { ok: false; error: string }>) => {
  const userId = await requirePermission('shifts:supervise');
  if (typeof id !== 'string' || !UUID.test(id)) return { ok: false as const, error: 'That sale could not be found.' };
  try {
    const c = getContainer();
    return await run((await c.companySettings.ensureSeeded()).id, userId, id);
  } catch (error) {
    console.error('[offline] review action', error);
    return { ok: false as const, error: 'That could not be done just now. Please try again.' };
  }
};

/** A supervisor: tries a parked sale again after the stock was put right. */
export async function retryParkedOfflineSaleAction(id: unknown) {
  return await sale(id, async (companyId, _userId, saleId) => await getContainer().offlineSales.retryParked(companyId, saleId));
}

/** A supervisor: gives a parked or refused sale up, with a reason that is kept. */
export async function discardOfflineSaleAction(id: unknown, reason: unknown) {
  return await sale(id, async (companyId, userId, saleId) => await getContainer().offlineSales.discard(companyId, { type: 'user', id: userId }, saleId, typeof reason === 'string' ? reason : ''));
}

/** A supervisor: marks a sale accepted with a difference as looked at. */
export async function acknowledgeOfflineSaleAction(id: unknown) {
  return await sale(id, async (companyId, userId, saleId) => await getContainer().offlineSales.acknowledge(companyId, { type: 'user', id: userId }, saleId));
}

// ── The setting (its own permission) ─────────────────────────────────────

const friendly = (error: unknown): string | null => (error instanceof OfflineError || error instanceof ReasonError ? error.message : null);
const reasonOf = (value: unknown): { code: string; text?: string } => {
  const r = obj(value);
  const code = typeof r.code === 'string' ? r.code : '';
  return typeof r.text === 'string' ? { code, text: r.text } : { code };
};

export interface OfflineSellingScreen {
  enabled: boolean;
  limits: OfflineLimits;
  version: number;
  updatedBy: string | null;
  updatedAt: string | null;
}

export async function offlineSellingScreenAction() {
  return await runSetting('offline_selling:manage', async ({ companyId }): Promise<OfflineSellingScreen> => await getContainer().offlineSales.settings(companyId), { friendly });
}

/** Switches selling with no connection on or off and sets its limits, with a reason. Only for the permission that exists for this alone. */
export async function saveOfflineSellingAction(raw: unknown, reason: unknown) {
  return await runSetting(
    'offline_selling:manage',
    async ({ companyId, userId }): Promise<OfflineSellingScreen> => {
      const input = obj(raw);
      const limits = obj(input.limits);
      if (typeof input.enabled !== 'boolean') throw new OfflineError('Say whether offline selling is on or off.');
      if (typeof limits.maxPerShift !== 'number' || typeof limits.maxHours !== 'number') throw new OfflineError('Give the most that can be sold offline in a shift and the longest a sale may wait.');
      const c = getContainer();
      await c.reasonCodes.ensureSystemReasons(companyId);
      await c.offlineSales.saveSettings(companyId, { type: 'user', id: userId }, { enabled: input.enabled, limits: { maxPerShift: limits.maxPerShift, maxHours: limits.maxHours } }, reasonOf(reason));
      return await c.offlineSales.settings(companyId);
    },
    { paths: ['/admin/settings/offline-selling', '/admin/cash-sales'], friendly },
  );
}
