'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from './action-runner';
import { fromCents } from './domain/receivables';
import { changeLabel } from './domain/inventory-posting';

const fin = () => getContainer().finance;
const PATH = '/admin/finance/inventory-posting';

export async function inventoryPostingOverviewAction() {
  return await run('inventory_posting:read', { surface: 'finance/inventory-posting', action: 'view' }, async (ctx) => {
    const [settings, checks, overview, recon] = await Promise.all([
      fin().setup.getSettings(ctx.companyId),
      fin().inventoryPosting.readiness(ctx.companyId),
      fin().inventoryPosting.overview(ctx.companyId),
      fin().inventoryPosting.reconciliation(ctx.companyId).catch(() => null),
    ]);
    const row = (e: (typeof overview.failed)[number]) => ({ id: e.id, kind: e.kind, what: changeLabel(e.changeType), productId: e.productId, quantity: e.quantity, unitCost: e.unitCost, value: e.value, eventDate: e.eventDate, attempts: e.attempts, lastError: e.lastError });
    return {
      goLive: settings?.inventoryGlGoLive ?? null,
      baseCurrency: settings?.baseCurrency ?? '',
      checks,
      counts: { pending: overview.counts.pending ?? 0, failed: overview.counts.failed ?? 0, posted: overview.counts.posted ?? 0, skipped: overview.counts.skipped ?? 0 },
      failed: overview.failed.map(row),
      recent: overview.recent.map(row),
      stockValue: fromCents(await fin().inventoryPosting.stockValueCents()),
      reconciliation: recon === null ? null : { live: recon.live, since: recon.since, gl: fromCents(recon.glCents), shelves: fromCents(recon.shelvesCents), waiting: fromCents(recon.waitingCents), waitingCount: recon.waitingCount, diff: fromCents(recon.diffCents) },
      can: { goLive: await canPermission('inventory_posting:go_live'), retry: await canPermission('inventory_posting:retry') },
    };
  });
}

export async function inventoryGoLiveAction(offsetAccountId: string) {
  return await run('inventory_posting:go_live', { surface: 'finance/inventory-posting', action: 'go_live' }, async (ctx) => {
    const out = await fin().inventoryPosting.goLive(ctx, { offsetAccountId });
    return { date: out.date, opening: fromCents(out.openingCents) };
  }, [PATH]);
}

export async function retryInventoryPostingAction(id?: number) {
  return await run('inventory_posting:retry', { surface: 'finance/inventory-posting', action: id === undefined ? 'retry_all' : 'retry_one' }, async (ctx) => {
    if (id !== undefined) return { posted: (await fin().inventoryPosting.retry(ctx, id)) ? 1 : 0, failed: 0 };
    return await fin().inventoryPosting.processDue(500);
  }, [PATH]);
}
