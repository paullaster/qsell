'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { AllocationForm, VoucherHeaderForm } from '@/lib/vendor-payment';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const PATHS = ['/admin/vendors/payments', '/admin/vendors/invoices', '/admin/vendors/payables'];

export async function paymentListAction(filter: { status?: string; vendorId?: string; before?: { stamp: string; id: string } | null } = {}) {
  return await run('vendor_payments:read', { surface: 'vendor_payments/list', action: 'view' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && filter.before.stamp.length <= 40 ? filter.before : null;
    return await getContainer().vendorPayments.list(ctx.companyId, { status: has(filter.status) ? str(filter.status, 20) : undefined, vendorId: has(filter.vendorId) && UUID.test(filter.vendorId) ? filter.vendorId : undefined, before });
  });
}

/** What the vendor owes a person choosing invoices or an advance to pay: open invoices (less what other vouchers hold) and approved advances. */
export async function paymentCandidatesAction(vendorId: string, exceptVoucherId: string | null = null) {
  return await run('vendor_payments:read', { surface: 'vendor_payments/edit', action: 'candidates' }, async (ctx) => {
    const container = getContainer();
    const vendor = id(vendorId);
    const [items, advances] = await Promise.all([
      container.vendorPayments.openItems(ctx.companyId, vendor, exceptVoucherId === null ? null : id(exceptVoucherId)),
      container.vendorPayments.advancesToPay(ctx.companyId, vendor),
    ]);
    return { items, advances };
  });
}

/** One voucher for reading or editing; with no id, what a new one starts from. */
export async function paymentAction(voucherId: string | null, fromInvoiceId: string | null = null) {
  return await run('vendor_payments:read', { surface: 'vendor_payments/view', action: 'view' }, async (ctx) => {
    const container = getContainer();
    const found = voucherId === null ? null : await container.vendorPayments.get(ctx.companyId, id(voucherId));
    if (voucherId !== null && found === null) throw new FinanceError('NOT_FOUND', 'That payment voucher does not exist.');
    const [create, approve, release, reverse, apply, onAccount] = await Promise.all([
      canPermission('vendor_payments:create'),
      canPermission('vendor_payments:approve'),
      canPermission('vendor_payments:release'),
      canPermission('vendor_payments:reverse'),
      canPermission('vendor_payments:apply_advance'),
      canPermission('vendor_payments:on_account'),
    ]);
    const me = ctx.actor.id;
    const prefill = voucherId === null && fromInvoiceId !== null && UUID.test(fromInvoiceId) ? await container.vendorPayments.prefill(ctx.companyId, fromInvoiceId) : null;
    const threshold = await container.vendorPayments.threshold(ctx.companyId);
    const forVendor = found !== null && found.voucher.status === 'draft' ? found.voucher.vendorId : (prefill?.vendorId ?? null);
    const candidates = forVendor === null
      ? { items: [], advances: [] }
      : { items: await container.vendorPayments.openItems(ctx.companyId, forVendor, found?.voucher.id ?? null), advances: await container.vendorPayments.advancesToPay(ctx.companyId, forVendor) };
    return {
      found,
      candidates,
      prefill,
      today: businessDate(),
      thresholdCents: threshold,
      can: { create, approve, release, reverse, apply, onAccount },
      me,
    };
  });
}

export async function saveVoucherAction(voucherId: string | null, header: unknown, allocations: unknown) {
  return await run('vendor_payments:create', { surface: 'vendor_payments/edit', action: voucherId === null ? 'create' : 'update' }, async (ctx) => {
    const h = obj(header);
    let kind: VoucherHeaderForm['kind'] = 'invoices';
    if (h.kind === 'advance') kind = 'advance';
    if (h.kind === 'on_account') {
      // A payment with no invoice behind it has a permission of its own.
      if (!(await canPermission('vendor_payments:on_account'))) throw new FinanceError('FORBIDDEN', 'You are not allowed to prepare a payment on account.');
      kind = 'on_account';
    }
    const clean: VoucherHeaderForm = { kind, vendorId: str(h.vendorId, 40), methodId: str(h.methodId, 40), narration: str(h.narration, 600), advanceId: str(h.advanceId, 40), amount: str(h.amount, 20) };
    for (const [k, v] of [['vendor', clean.vendorId], ['way of paying', clean.methodId]] as const) if (v !== '' && !UUID.test(v)) throw new FinanceError('INVALID', `Choose the ${k} again.`);
    const rows: AllocationForm[] = (Array.isArray(allocations) ? allocations.slice(0, 200) : []).map((a) => ({ purchaseInvoiceId: str(obj(a).purchaseInvoiceId, 40), amount: str(obj(a).amount, 20), closeRemainder: obj(a).closeRemainder === true }));
    return await getContainer().vendorPayments.saveDraft(ctx, voucherId === null ? null : id(voucherId), clean, rows);
  }, PATHS);
}

export async function submitVoucherAction(voucherId: string) {
  return await run('vendor_payments:create', { surface: 'vendor_payments/edit', action: 'submit' }, async (ctx) => {
    await getContainer().vendorPayments.submit(ctx, id(voucherId));
  }, PATHS);
}

export async function approveVoucherAction(voucherId: string) {
  return await run('vendor_payments:approve', { surface: 'vendor_payments/edit', action: 'approve' }, async (ctx) => await getContainer().vendorPayments.approve(ctx, id(voucherId)), PATHS);
}

export async function sendBackVoucherAction(voucherId: string, reason: string) {
  return await run('vendor_payments:approve', { surface: 'vendor_payments/edit', action: 'send_back' }, async (ctx) => {
    await getContainer().vendorPayments.sendBack(ctx, id(voucherId), str(reason));
  }, PATHS);
}

export async function cancelVoucherAction(voucherId: string, reason: string) {
  return await run('vendor_payments:create', { surface: 'vendor_payments/edit', action: 'cancel' }, async (ctx) => {
    await getContainer().vendorPayments.cancel(ctx, id(voucherId), str(reason));
  }, PATHS);
}

export async function payVoucherAction(voucherId: string, reference: string, paidOn: string) {
  return await run('vendor_payments:release', { surface: 'vendor_payments/edit', action: 'pay' }, async (ctx) => await getContainer().vendorPayments.pay(ctx, id(voucherId), { reference: str(reference, 120), paidOn: str(paidOn, 12) }), PATHS);
}

/** Sends an approved voucher to the vendor's M-Pesa destination through the platform. The voucher's own approval is the approval for the money. */
export async function payVoucherThroughMpesaAction(voucherId: string) {
  return await run('vendor_payments:release', { surface: 'vendor_payments/edit', action: 'pay_through_mpesa' }, async (ctx) => {
    const c = getContainer();
    const plan = await c.vendorPayments.prepareMpesaPayout(ctx, id(voucherId));
    const { OperationRefused } = await import('@/server/domains/payments/daraja/operations');
    try {
      const r = await c.paymentEngine.disbursements.request({
        companyId: ctx.companyId,
        providerId: plan.providerId,
        methodId: plan.methodId,
        operation: plan.operation,
        preApproved: true,
        input: plan.input,
        requestedBy: ctx.actor.id ?? 'system',
        subject: { type: 'vendor_payment', id: id(voucherId) },
        idempotencyKey: `vendor-payment:${id(voucherId)}:payout:${String(plan.attempt)}`,
        origin: ctx.origin,
      });
      return { operationId: r.op.id, status: r.status };
    } catch (error) {
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, PATHS);
}

export async function reverseVoucherAction(voucherId: string, reason: string) {
  return await run('vendor_payments:reverse', { surface: 'vendor_payments/edit', action: 'reverse' }, async (ctx) => {
    await getContainer().vendorPayments.reverse(ctx, id(voucherId), str(reason));
  }, PATHS);
}

export async function applyAdvanceAction(purchaseInvoiceId: string) {
  return await run('vendor_payments:apply_advance', { surface: 'vendor_payments/invoice', action: 'apply_advance' }, async (ctx) => await getContainer().vendorPayments.applyAdvance(ctx, id(purchaseInvoiceId)), PATHS);
}

export async function applyCreditAction(purchaseInvoiceId: string) {
  return await run('vendor_payments:apply_advance', { surface: 'vendor_payments/invoice', action: 'apply_credit' }, async (ctx) => await getContainer().vendorPayments.applyCredit(ctx, id(purchaseInvoiceId)), PATHS);
}

export async function ageingAction(asOf?: string) {
  return await run('vendor_payments:read', { surface: 'vendor_payments/payables', action: 'ageing' }, async (ctx) => {
    const date = has(asOf) && /^\d{4}-\d{2}-\d{2}$/.test(asOf) ? asOf : businessDate();
    return await getContainer().payablesReports.ageing(ctx.companyId, date);
  });
}

export async function statementAction(vendorId: string) {
  return await run('vendor_payments:read', { surface: 'vendor_payments/payables', action: 'statement' }, async (ctx) => {
    const found = await getContainer().payablesReports.statement(ctx.companyId, id(vendorId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That vendor does not exist.');
    return found;
  });
}

/** The last comparison of the vendor ledger with the books, and a way to run it now. */
export async function payablesCheckAction() {
  return await run('vendor_payments:read', { surface: 'vendor_payments/payables', action: 'check_view' }, async (ctx) => await getContainer().payablesReports.lastCheck(ctx.companyId));
}

export async function runPayablesCheckAction() {
  return await run('vendor_payments:read', { surface: 'vendor_payments/payables', action: 'check_run' }, async (ctx) => await getContainer().payablesReports.runCheck(ctx.companyId, ctx.actor.id ?? 'unknown'), ['/admin/vendors/payables']);
}

/** Values what is owed to vendors in other currencies at today's rate; the next day it is undone. */
export async function revalueForeignPayablesAction() {
  return await run('vendor_payments:revalue', { surface: 'vendor_payments/payables', action: 'revalue' }, async (ctx) => await getContainer().payablesFx.revalue(ctx), ['/admin/vendors/payables']);
}

export async function lastPayablesRevaluationAction() {
  return await run('vendor_payments:read', { surface: 'vendor_payments/payables', action: 'revaluation_view' }, async (ctx) => ({ last: await getContainer().payablesFx.last(ctx.companyId), can: await canPermission('vendor_payments:revalue') }));
}
