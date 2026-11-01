'use server';

import { and, count, eq, gte } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import { branches, orders } from '@/server/db/drizzle/schema';
import { getContainer } from '@/server/di/container';
import { objectOf, runDelivery } from '@/server/domains/delivery/action-support';
import { DeliveryError } from '@/server/domains/delivery/errors';

const PATHS = ['/admin/delivery/maps'];
const PROBE_GAP_MS = 8000;
const lastProbe = new Map<string, number>();

/** What the map service screen shows: the current choice, how each service has behaved, and the shop's own volume for the cost estimate. */
export async function geoSettingsPageAction() {
  return await runDelivery('deliveries:read', async (ctx) => {
    const { geoSettings } = getContainer();
    const since = new Date(Date.now() - 30 * 86_400_000);
    const [choice, metrics, [ordersRow], [branchRow]] = await Promise.all([
      geoSettings.get(ctx.companyId),
      geoSettings.metrics(ctx.companyId, 30),
      drizzleDb.select({ n: count() }).from(orders).where(gte(orders.createdAt, since)),
      drizzleDb.select({ n: count() }).from(branches).where(and(eq(branches.companyId, ctx.companyId), eq(branches.isActive, true))),
    ]);
    return { choice: { ...choice, updatedAt: choice.updatedAt?.toISOString() ?? null }, metrics, shop: { ordersLast30Days: ordersRow?.n ?? 0, branches: branchRow?.n ?? 0 } };
  });
}

export async function saveGeoSettingsAction(raw: unknown) {
  return await runDelivery(
    'deliveries:manage',
    async (ctx) => {
      const i = objectOf(raw);
      const saved = await getContainer().geoSettings.save(ctx.companyId, ctx.userId, { driver: i.driver, config: i.config, expectedVersion: i.expectedVersion, reason: i.reason });
      return { ...saved, updatedAt: saved.updatedAt?.toISOString() ?? null };
    },
    PATHS,
  );
}

/** Tries a service as set up in the form, without saving it. Spaced out, because it calls a real server. */
export async function tryGeoSettingsAction(raw: unknown) {
  return await runDelivery('deliveries:manage', async (ctx) => {
    const last = lastProbe.get(ctx.companyId) ?? 0;
    if (Date.now() - last < PROBE_GAP_MS) throw new DeliveryError('Wait a few seconds before trying again. The map servers ask not to be hurried.', 'CONFLICT');
    lastProbe.set(ctx.companyId, Date.now());
    const i = objectOf(raw);
    return { steps: await getContainer().geoSettings.probe(i.driver, i.config) };
  });
}
