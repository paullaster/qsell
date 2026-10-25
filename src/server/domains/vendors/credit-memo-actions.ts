'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const PATHS = ['/admin/vendors/credit-memos', '/admin/vendors/payables'];

export async function creditQueueAction(filter: { state?: string; before?: { stamp: string; id: string } | null } = {}) {
  return await run('credit_memos:read', { surface: 'credit_memos/queue', action: 'view' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && filter.before.stamp.length <= 40 ? filter.before : null;
    return await getContainer().creditMemos.queue(ctx.companyId, { state: has(filter.state) ? str(filter.state, 20) : undefined, before });
  });
}

export async function creditMemoAction(memoId: string) {
  return await run('credit_memos:read', { surface: 'credit_memos/view', action: 'view' }, async (ctx) => {
    const found = await getContainer().creditMemos.get(ctx.companyId, id(memoId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That credit memo does not exist.');
    const [process, approve, reject, post] = await Promise.all([canPermission('credit_memos:process'), canPermission('credit_memos:approve'), canPermission('credit_memos:reject'), canPermission('credit_memos:post')]);
    const me = ctx.actor.id;
    const separate = me === null || me !== found.memo.assignedTo;
    return { ...found, can: { process, reject, post, approve: approve && separate, approveBlockedBySeparation: approve && !separate } };
  });
}

export async function pickUpCreditAction(memoId: string) {
  return await run('credit_memos:process', { surface: 'credit_memos/workspace', action: 'pick_up' }, async (ctx) => {
    await getContainer().creditMemos.pickUp(ctx, id(memoId));
  }, PATHS);
}

export async function approveCreditAction(memoId: string) {
  return await run('credit_memos:approve', { surface: 'credit_memos/workspace', action: 'approve' }, async (ctx) => {
    await getContainer().creditMemos.approve(ctx, id(memoId));
  }, PATHS);
}

export async function returnCreditAction(memoId: string, reasonCode: string, note: string) {
  return await run('credit_memos:process', { surface: 'credit_memos/workspace', action: 'return' }, async (ctx) => {
    await getContainer().creditMemos.returnToVendor(ctx, id(memoId), str(reasonCode, 30), str(note));
  }, PATHS);
}

export async function rejectCreditAction(memoId: string, reasonCode: string, note: string) {
  return await run('credit_memos:reject', { surface: 'credit_memos/workspace', action: 'reject' }, async (ctx) => {
    await getContainer().creditMemos.reject(ctx, id(memoId), str(reasonCode, 30), str(note));
  }, PATHS);
}

export async function postCreditAction(memoId: string) {
  return await run('credit_memos:post', { surface: 'credit_memos/workspace', action: 'post' }, async (ctx) => await getContainer().creditMemos.post(ctx, id(memoId)), [...PATHS, '/admin/vendors/invoices']);
}
