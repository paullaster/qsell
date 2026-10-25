'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const cents = (value: unknown): number | null => {
  const text = str(value, 20).trim();
  return /^\d+(\.\d{1,2})?$/.test(text) ? Math.round(Number(text) * 100) : null;
};
const PATHS = ['/admin/vendors/payments', '/admin/vendors/payments/runs', '/admin/vendors/invoices', '/admin/vendors/payables'];

export async function runListAction(filter: { status?: string; before?: { stamp: string; id: string } | null } = {}) {
  return await run('vendor_payments:read', { surface: 'payment_runs/list', action: 'view' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && filter.before.stamp.length <= 40 ? filter.before : null;
    return await getContainer().paymentRuns.list(ctx.companyId, { status: has(filter.status) ? str(filter.status, 20) : undefined, before });
  });
}

export async function runSuggestAction(input: unknown) {
  return await run('vendor_payments:create', { surface: 'payment_runs/propose', action: 'suggest' }, async (ctx) => {
    const i = obj(input);
    return await getContainer().paymentRuns.suggest(ctx.companyId, {
      methodId: id(i.methodId),
      dueOn: str(i.dueOn, 12),
      vendorId: has(str(i.vendorId, 40)) ? id(i.vendorId) : undefined,
      minCents: cents(i.min),
      maxCents: cents(i.max),
    });
  });
}

export async function runCreateAction(input: unknown) {
  return await run('vendor_payments:create', { surface: 'payment_runs/propose', action: 'create' }, async (ctx) => {
    const i = obj(input);
    const selections = (Array.isArray(i.selections) ? i.selections.slice(0, 500) : []).map((s) => ({
      vendorId: id(obj(s).vendorId),
      allocations: (Array.isArray(obj(s).allocations) ? (obj(s).allocations as unknown[]).slice(0, 200) : []).map((a) => ({ purchaseInvoiceId: str(obj(a).purchaseInvoiceId, 40), amount: str(obj(a).amount, 20) })),
    }));
    return await getContainer().paymentRuns.create(ctx, { methodId: id(i.methodId), executionDate: str(i.executionDate, 12), note: str(i.note, 300), selections });
  }, PATHS);
}

export async function runAction(runId: string) {
  return await run('vendor_payments:read', { surface: 'payment_runs/view', action: 'view' }, async (ctx) => {
    const found = await getContainer().paymentRuns.get(ctx.companyId, id(runId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That payment run does not exist.');
    const [create, approve, release] = await Promise.all([canPermission('vendor_payments:create'), canPermission('vendor_payments:approve'), canPermission('vendor_payments:release')]);
    return { ...found, today: businessDate(), me: ctx.actor.id, can: { create, approve, release } };
  });
}

export async function runSubmitAction(runId: string) {
  return await run('vendor_payments:create', { surface: 'payment_runs/view', action: 'submit' }, async (ctx) => {
    await getContainer().paymentRuns.submit(ctx, id(runId));
  }, PATHS);
}

export async function runApproveAction(runId: string, approveIds: string[], sendBackReason: string) {
  return await run('vendor_payments:approve', { surface: 'payment_runs/view', action: 'approve' }, async (ctx) => {
    const ids = (Array.isArray(approveIds) ? approveIds.slice(0, 500) : []).map((x) => id(x));
    return await getContainer().paymentRuns.approve(ctx, id(runId), { approveIds: ids, sendBackReason: str(sendBackReason) });
  }, PATHS);
}

export async function runReleaseAction(runId: string, format: string, firstChequeNo: string) {
  return await run('vendor_payments:release', { surface: 'payment_runs/view', action: 'release' }, async (ctx) => await getContainer().paymentRuns.release(ctx, id(runId), { format: str(format, 12), firstChequeNo: str(firstChequeNo, 20) }), PATHS);
}

export async function runDownloadAction(runId: string) {
  return await run('vendor_payments:release', { surface: 'payment_runs/view', action: 'download' }, async (ctx) => await getContainer().paymentRuns.download(ctx, id(runId)));
}

export async function runConfirmAction(runId: string, reference: string, paidOn: string) {
  return await run('vendor_payments:release', { surface: 'payment_runs/view', action: 'confirm' }, async (ctx) => await getContainer().paymentRuns.confirm(ctx, id(runId), { reference: str(reference, 120), paidOn: str(paidOn, 12) }), PATHS);
}

export async function runCancelAction(runId: string, reason: string) {
  return await run('vendor_payments:create', { surface: 'payment_runs/view', action: 'cancel' }, async (ctx) => {
    await getContainer().paymentRuns.cancel(ctx, id(runId), str(reason));
  }, PATHS);
}
