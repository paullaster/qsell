'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { postingPermissions, run } from './action-runner';
import { fromCents } from './domain/receivables';
import { FinanceError } from './errors';
import type { RefundInput } from './receivables/refund-service';
import type { RefundSource, RefundStatus } from '@/server/db/drizzle/schema';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance/refunds';

export async function searchCustomersForRefundAction(q: string) {
  return run('refunds:create', { surface: 'finance/refunds/new', action: 'search_customers' }, async (ctx) => fin().receipts.searchCustomers(ctx.companyId, q));
}

export async function refundOptionsAction(customerId?: string) {
  return run('refunds:create', { surface: 'finance/refunds/new', action: 'options' }, async (ctx) => {
    const [methods, reasons] = await Promise.all([fin().paymentMethods.list(ctx.companyId), getContainer().reasonCodes.list(ctx.companyId)]);
    const obligations = customerId ? await fin().refunds.obligations(ctx.companyId, customerId) : [];
    return {
      methods: methods
        .filter((m) => m.method.enabled && !m.bankBlocked && m.method.usableFor.includes('customer_refund') && m.method.refundDestination === 'manual')
        .map((m) => ({ id: m.method.id, name: m.method.name, kind: m.method.kind })),
      reasons: reasons.filter((r) => r.isActive).map((r) => ({ code: r.code, description: r.description, requiresComment: r.requiresComment })),
      obligations: obligations.map((o) => ({ kind: o.kind, id: o.id, label: o.label, currency: o.currency, available: fromCents(o.availableCents) })),
      customerName: customerId ? (await fin().refunds.customerName(ctx.companyId, customerId)) : null,
      canChangeDestination: await canPermission('refunds:change_destination'),
    };
  });
}

export async function createRefundAction(input: Omit<RefundInput, 'mayChangeDestination'>, submit = false) {
  return run('refunds:create', { surface: 'finance/refunds/new', action: submit ? 'create_and_submit' : 'create_draft' }, async (ctx) => {
    if (submit && !(await canPermission('refunds:submit'))) throw new FinanceError('CANNOT_SUBMIT', 'You may ask for refunds but not send them on. Save it as a draft instead.');
    const created = await fin().refunds.create(ctx, { ...input, mayChangeDestination: await canPermission('refunds:change_destination') });
    if (!submit) return { ...created, status: 'draft' as RefundStatus, submitError: null as string | null };
    try {
      const out = await fin().refunds.submit({ ...ctx, origin: { ...ctx.origin, permissionUsed: 'refunds:submit' } }, created.id);
      return { ...created, status: out.status, submitError: null as string | null };
    } catch (error) {
      if (error instanceof FinanceError) return { ...created, status: 'draft' as RefundStatus, submitError: error.message as string | null };
      throw error;
    }
  }, [ROOT]);
}

export async function submitRefundAction(id: string) {
  return run('refunds:submit', { surface: 'finance/refunds/detail', action: 'submit' }, async (ctx) => fin().refunds.submit(ctx, id), [ROOT, `${ROOT}/${id}`]);
}

export async function cancelRefundAction(id: string, reason: { code: string; text?: string }) {
  return run('refunds:cancel', { surface: 'finance/refunds/detail', action: 'cancel' }, async (ctx) => fin().refunds.cancel(ctx, id, reason, await postingPermissions()), [ROOT, `${ROOT}/${id}`, '/admin/finance/receivables/credit-note-excess']);
}

export async function recordRefundPayoutAction(id: string, input: { paidFromMethodId: string; payoutDate?: string; reference: string }) {
  return run('refunds:record_manual_payout', { surface: 'finance/refunds/detail', action: 'record_payout' }, async (ctx) => fin().refunds.recordPayout(ctx, id, { ...input, permissions: await postingPermissions() }), [ROOT, `${ROOT}/${id}`]);
}

/** Sends an approved refund to the customer's phone through M-Pesa. The refund's own approval is the approval for the money. */
export async function payRefundThroughMpesaAction(id: string) {
  return run('refunds:pay_automatic', { surface: 'finance/refunds/detail', action: 'pay_through_mpesa' }, async (ctx) => {
    const { getContainer } = await import('@/server/di/container');
    const c = getContainer();
    const plan = await c.finance.refunds.prepareAutomatic(ctx, id);
    const { OperationRefused } = await import('@/server/domains/payments/daraja/operations');
    try {
      const r = await c.paymentEngine.disbursements.request({
        companyId: ctx.companyId, providerId: plan.providerId, methodId: plan.methodId, operation: 'b2c', preApproved: true,
        input: { phone: plan.phone, amount: plan.amount.split('.')[0], commandId: 'BusinessPayment', remarks: `Refund ${plan.number}`.slice(0, 100) },
        requestedBy: ctx.actor.id ?? 'system', subject: { type: 'refund', id }, idempotencyKey: `refund:${id}:payout:${plan.attempt}`,
        origin: ctx.origin as unknown as Record<string, unknown>,
      });
      return { operationId: r.op.id, status: r.status };
    } catch (error) {
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, [ROOT, `${ROOT}/${id}`]);
}

export async function listRefundsAction(filter: { status?: RefundStatus; q?: string; before?: string } = {}) {
  return run('refunds:read', { surface: 'finance/refunds', action: 'list' }, async (ctx) => {
    const page = await fin().refunds.list(ctx.companyId, filter);
    return {
      nextBefore: page.nextBefore,
      rows: page.rows.map((x) => ({
        id: x.r.id,
        number: x.r.number,
        status: x.r.status,
        amount: x.r.amount,
        currency: x.r.currency,
        customerId: x.r.customerId,
        customer: x.customerName,
        customerNumber: x.customerNumber,
        method: x.methodName,
        reason: x.r.reasonCode,
        source: x.r.sourceKind,
        detailsChanged: x.r.detailsChanged,
        createdAt: x.r.createdAt.toISOString(),
        paidAt: x.r.paidAt ? x.r.paidAt.toISOString() : null,
      })),
      can: { create: await canPermission('refunds:create') },
    };
  });
}

export async function refundDetailAction(id: string) {
  return run('refunds:read', { surface: 'finance/refunds/detail', action: 'view' }, async (ctx) => {
    const d = await fin().refunds.detail(ctx.companyId, id);
    if (!d) throw new FinanceError('NOT_FOUND', 'That refund does not exist.');
    const media = getContainer().media;
    const attachments = await Promise.all(d.attachments.map(async (a) => ({ id: a.id, fileName: a.fileName, note: a.note, createdAt: a.createdAt.toISOString(), url: await media.deliveryUrlById(a.mediaAssetId).catch(() => null) })));
    const [methods, reasons] = await Promise.all([fin().paymentMethods.list(ctx.companyId), getContainer().reasonCodes.list(ctx.companyId)]);
    const r = d.r;
    const name = (x: string | null) => (x ? (d.actors[x] ?? x) : null);
    return {
      id: r.id,
      number: r.number,
      status: r.status,
      amount: r.amount,
      currency: r.currency,
      customer: { id: d.customer.id, name: d.customer.name, number: d.customer.number, phone: d.customer.phone },
      method: { id: d.method.id, name: d.method.name, kind: d.method.kind, bankAccountId: d.method.balancingBankAccountId, automatic: d.method.refundDestination === 'automatic' },
      source: d.sourceLabel,
      sourceKind: r.sourceKind,
      reason: r.reasonCode,
      reasonText: r.reasonText,
      payoutDetails: r.payoutDetails,
      detailsChanged: r.detailsChanged,
      requestedBy: name(r.requestedBy),
      approvedBy: name(r.approvedBy),
      approvedAt: r.approvedAt ? r.approvedAt.toISOString() : null,
      paidBy: name(r.paidBy),
      bankMatchedAt: r.bankMatchedAt ? r.bankMatchedAt.toISOString() : null,
      paidAt: r.paidAt ? r.paidAt.toISOString() : null,
      payoutReference: r.payoutReference,
      payoutDate: r.payoutDate,
      attachments,
      events: d.events.map((e) => ({ id: String(e.id), event: e.event, from: e.fromStatus, to: e.toStatus, reasonCode: e.reasonCode, reasonText: e.reasonText, by: name(e.actorId) ?? e.actorType, surface: (e.origin as { surface?: string }).surface ?? null, permission: (e.origin as { permissionUsed?: string }).permissionUsed ?? null, at: e.createdAt.toISOString(), data: e.data })),
      payFrom: methods.filter((m) => m.method.enabled && !m.bankBlocked && m.bankCurrency === r.currency && m.method.kind !== 'cheque').map((m) => ({ id: m.method.id, label: `${m.method.name} — ${m.bankCode}${m.branchName ? ` (${m.branchName})` : ''}` })),
      reasons: reasons.filter((x) => x.isActive).map((x) => ({ code: x.code, description: x.description, requiresComment: x.requiresComment })),
      can: {
        submit: await canPermission('refunds:submit'),
        cancel: await canPermission('refunds:cancel'),
        pay: await canPermission('refunds:record_manual_payout'),
        payAutomatic: await canPermission('refunds:pay_automatic'),
        attach: await canPermission('refunds:upload_evidence'),
      },
    };
  });
}

export async function refundReportAction(from: string, to: string) {
  return run('refunds:read', { surface: 'finance/refunds/report', action: 'view' }, async (ctx) => {
    const [rep, recon] = await Promise.all([fin().refunds.report(ctx.companyId, from, to), fin().refunds.payableReconciliation(ctx.companyId)]);
    return {
      byStatus: rep.byStatus.map((x) => ({ status: x.status, count: x.n, total: x.total })),
      byReason: rep.byReason.map((x) => ({ reason: x.reason, count: x.n, total: x.total })),
      byMethod: rep.byMethod.map((x) => ({ method: x.method, count: x.n, total: x.total })),
      stuck: rep.stuck.map((x) => ({ id: x.r.id, number: x.r.number, customer: x.customerName, amount: x.r.amount, currency: x.r.currency, approvedAt: x.r.approvedAt ? x.r.approvedAt.toISOString() : null })),
      reconciliation: recon.map((r) => ({ accountNo: r.accountNo, accountName: r.accountName, gl: fromCents(r.glCents), owed: fromCents(r.owedCents), diff: fromCents(r.diffCents) })),
    };
  });
}

export type { RefundSource };
