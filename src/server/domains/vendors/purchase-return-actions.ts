'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { ReturnHeaderForm, ReturnLineForm } from '@/lib/purchase-return';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const PATHS = ['/admin/vendors/returns'];

async function flags() {
  const [create, post] = await Promise.all([canPermission('purchase_returns:create'), canPermission('purchase_returns:post')]);
  return { create, post };
}

export async function returnsAction(status?: string) {
  return await run('purchase_returns:read', { surface: 'purchase_returns', action: 'list' }, async (ctx) => ({ rows: await getContainer().purchaseReturns.list(ctx.companyId, { status: ['draft', 'posted', 'cancelled'].includes(status ?? '') ? status : undefined }) }));
}

/** A note's lines with how much of each can go back, to start a return from. */
export async function returnableAction(rgnId: string) {
  return await run('purchase_returns:create', { surface: 'purchase_returns', action: 'returnable' }, async (ctx) => {
    const found = await getContainer().purchaseReturns.returnable(ctx.companyId, id(rgnId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That received goods note does not exist.');
    return { ...found, today: businessDate() };
  });
}

export async function saveReturnAction(returnId: string | null, rgnId: string, header: unknown, lines: unknown) {
  return await run('purchase_returns:create', { surface: 'purchase_returns', action: returnId === null ? 'create' : 'update' }, async (ctx) => {
    const h = obj(header);
    const clean: ReturnHeaderForm = { returnDate: str(h.returnDate, 12), reason: str(h.reason, 30), vendorReference: str(h.vendorReference, 100), notes: str(h.notes, 600) };
    const rows: ReturnLineForm[] = (Array.isArray(lines) ? lines : []).slice(0, 200).map((l) => ({ rgnLineId: id(obj(l).rgnLineId), quantity: str(obj(l).quantity, 20) }));
    return await getContainer().purchaseReturns.saveDraft(ctx, returnId === null ? null : id(returnId), id(rgnId), clean, rows);
  }, PATHS);
}

export async function returnAction(returnId: string) {
  return await run('purchase_returns:read', { surface: 'purchase_returns', action: 'view' }, async (ctx) => {
    const found = await getContainer().purchaseReturns.get(ctx.companyId, id(returnId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That return does not exist.');
    return { ...found, can: await flags(), me: ctx.actor.id };
  });
}

export async function postReturnAction(returnId: string) {
  return await run('purchase_returns:post', { surface: 'purchase_returns', action: 'post' }, async (ctx) => await getContainer().purchaseReturns.post(ctx, id(returnId)), [...PATHS, '/admin/vendors/receipts']);
}

export async function cancelReturnAction(returnId: string, reason: string) {
  return await run('purchase_returns:create', { surface: 'purchase_returns', action: 'cancel' }, async (ctx) => {
    await getContainer().purchaseReturns.cancelDraft(ctx, id(returnId), str(reason));
  }, PATHS);
}
