'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const PATHS = ['/admin/vendors/refunds', '/admin/vendors/payables'];

async function flags() {
  const [create, post, reverse] = await Promise.all([canPermission('vendor_refunds:create'), canPermission('vendor_refunds:post'), canPermission('vendor_refunds:reverse')]);
  return { create, post, reverse };
}

export async function refundsAction(status?: string) {
  return await run('vendor_payments:read', { surface: 'vendor_refunds', action: 'list' }, async (ctx) => {
    const allowed = ['pending', 'posted', 'cancelled', 'reversed'];
    return { refunds: await getContainer().vendorRefunds.list(ctx.companyId, { status: allowed.includes(status ?? '') ? status : undefined }), can: await flags() };
  });
}

/** What a vendor has paid or been credited that could be paid back. */
export async function refundableAction(vendorId: string) {
  return await run('vendor_refunds:create', { surface: 'vendor_refunds', action: 'refundable' }, async (ctx) => ({ credits: await getContainer().vendorRefunds.refundable(ctx.companyId, id(vendorId)) }));
}

export async function requestRefundAction(input: unknown) {
  return await run('vendor_refunds:create', { surface: 'vendor_refunds', action: 'request' }, async (ctx) => {
    const i = obj(input);
    return await getContainer().vendorRefunds.request(ctx, { creditEntryId: id(i.creditEntryId), methodId: id(i.methodId), amount: str(i.amount, 20), note: str(i.note, 400) });
  }, PATHS);
}

export async function refundAction(refundId: string) {
  return await run('vendor_payments:read', { surface: 'vendor_refunds', action: 'view' }, async (ctx) => {
    const found = await getContainer().vendorRefunds.get(ctx.companyId, id(refundId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That refund does not exist.');
    return { ...found, can: await flags(), me: ctx.actor.id, today: businessDate() };
  });
}

export async function postRefundAction(refundId: string, input: unknown) {
  return await run('vendor_refunds:post', { surface: 'vendor_refunds', action: 'post' }, async (ctx) => {
    const i = obj(input);
    return await getContainer().vendorRefunds.post(ctx, id(refundId), { reference: str(i.reference, 120), receivedOn: str(i.receivedOn, 10) });
  }, PATHS);
}

export async function cancelRefundAction(refundId: string, reason: string) {
  return await run('vendor_refunds:create', { surface: 'vendor_refunds', action: 'cancel' }, async (ctx) => {
    await getContainer().vendorRefunds.cancel(ctx, id(refundId), str(reason));
  }, PATHS);
}

export async function reverseRefundAction(refundId: string, reason: string) {
  return await run('vendor_refunds:reverse', { surface: 'vendor_refunds', action: 'reverse' }, async (ctx) => {
    await getContainer().vendorRefunds.reverse(ctx, id(refundId), str(reason));
  }, PATHS);
}
