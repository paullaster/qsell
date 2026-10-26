'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import type { LandedCostForm } from '@/lib/landed-cost';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const PATHS = ['/admin/vendors/landed-costs'];

export async function landedCostsAction() {
  return await run('landed_costs:read', { surface: 'landed_costs', action: 'list' }, async (ctx) => ({ rows: await getContainer().landedCosts.list(ctx.companyId), canCreate: await canPermission('landed_costs:create') }));
}

/** How a charge would be spread over a note's stock lines, to see before saving. */
export async function landedPreviewAction(rgnId: string, amount: string, method: string) {
  return await run('landed_costs:create', { surface: 'landed_costs', action: 'preview' }, async (ctx) => {
    const found = await getContainer().landedCosts.preview(ctx.companyId, id(rgnId), str(amount, 20), method === 'quantity' ? 'quantity' : 'value');
    if (found === null) throw new FinanceError('NOT_FOUND', 'That received goods note does not exist.');
    return found;
  });
}

export async function saveLandedCostAction(landedId: string | null, rgnId: string, form: unknown) {
  return await run('landed_costs:create', { surface: 'landed_costs', action: landedId === null ? 'create' : 'update' }, async (ctx) => {
    const f = obj(form);
    const clean: LandedCostForm = { kind: str(f.kind, 20), description: str(f.description, 300), reference: str(f.reference, 100), amount: str(f.amount, 20), method: f.method === 'quantity' ? 'quantity' : 'value' };
    return await getContainer().landedCosts.saveDraft(ctx, landedId === null ? null : id(landedId), id(rgnId), clean);
  }, PATHS);
}

export async function landedCostAction(landedId: string) {
  return await run('landed_costs:read', { surface: 'landed_costs', action: 'view' }, async (ctx) => {
    const found = await getContainer().landedCosts.get(ctx.companyId, id(landedId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That landed cost does not exist.');
    const [create, post] = await Promise.all([canPermission('landed_costs:create'), canPermission('landed_costs:post')]);
    return { ...found, can: { create, post }, me: ctx.actor.id };
  });
}

export async function postLandedCostAction(landedId: string) {
  return await run('landed_costs:post', { surface: 'landed_costs', action: 'post' }, async (ctx) => await getContainer().landedCosts.post(ctx, id(landedId)), PATHS);
}

export async function cancelLandedCostAction(landedId: string, reason: string) {
  return await run('landed_costs:create', { surface: 'landed_costs', action: 'cancel' }, async (ctx) => {
    await getContainer().landedCosts.cancel(ctx, id(landedId), str(reason));
  }, PATHS);
}
