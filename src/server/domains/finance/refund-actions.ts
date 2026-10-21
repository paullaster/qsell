'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { postingPermissions, run } from './action-runner';
import { fromCents } from './domain/receivables';
import { lastDays } from '@/lib/report-window';
import { FinanceError } from './errors';
import type { RefundInput } from './receivables/refund-service';
import type { RefundLimitValues } from './domain/refund-limits';
import type { RefundSource, RefundStatus } from '@/server/db/drizzle/schema';

import { has } from '@/lib/values';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance/refunds';

/**
 * Where "New refund" starts: the customer and the thing to refund from when the page was opened
 * from a customer or a receipt, and whether this person may pay to details other than the record's.
 * The lists to choose from (customers, what is owed, methods, reasons) are searched on demand.
 */
export async function refundStartAction(customerId?: string, sourceKey?: string) {
  return await run('refunds:create', { surface: 'finance/refunds/new', action: 'start' }, async (ctx) => {
    const canChangeDestination = await canPermission('refunds:change_destination');
    if (customerId === undefined) return { customer: null, source: null, canChangeDestination };
    const [brief, obligations] = await Promise.all([
      fin().refunds.customerBrief(ctx.companyId, customerId),
      fin().refunds.obligations(ctx.companyId, customerId),
    ]);
    const chosen = sourceKey === undefined ? undefined : obligations.find((o) => `${o.kind}:${o.id}` === sourceKey);
    return {
      customer: brief === null ? null : { id: customerId, label: brief.name, meta: { phone: brief.phone ?? '' } },
      source: chosen === undefined ? null : { id: `${chosen.kind}:${chosen.id}`, label: chosen.label, meta: { kind: chosen.kind, sourceId: chosen.id, currency: chosen.currency, available: fromCents(chosen.availableCents) } },
      canChangeDestination,
    };
  });
}

export async function createRefundAction(input: Omit<RefundInput, 'mayChangeDestination'>, submit = false) {
  return await run('refunds:create', { surface: 'finance/refunds/new', action: submit ? 'create_and_submit' : 'create_draft' }, async (ctx) => {
    if (submit && !(await canPermission('refunds:submit'))) throw new FinanceError('CANNOT_SUBMIT', 'You may ask for refunds but not send them on. Save it as a draft instead.');
    const created = await fin().refunds.create(ctx, { ...input, mayChangeDestination: await canPermission('refunds:change_destination') });
    if (!submit) return { ...created, status: 'draft' as RefundStatus, submitError: null as string | null };
    try {
      const out = await fin().refunds.submit({ ...ctx, origin: { ...ctx.origin, permissionUsed: 'refunds:submit' } }, created.id);
      return { ...created, status: out.status, submitError: null as string | null };
    } catch (error) {
      if (error instanceof FinanceError) return { ...created, status: 'draft' as RefundStatus, submitError: error.message };
      throw error;
    }
  }, [ROOT]);
}

export async function submitRefundAction(id: string) {
  return await run('refunds:submit', { surface: 'finance/refunds/detail', action: 'submit' }, async (ctx) => await fin().refunds.submit(ctx, id), [ROOT, `${ROOT}/${id}`]);
}

export async function cancelRefundAction(id: string, reason: { code: string; text?: string }) {
  return await run('refunds:cancel', { surface: 'finance/refunds/detail', action: 'cancel' }, async (ctx) => await fin().refunds.cancel(ctx, id, reason, await postingPermissions()), [ROOT, `${ROOT}/${id}`, '/admin/finance/receivables/credit-note-excess']);
}

export async function recordRefundPayoutAction(id: string, input: { paidFromMethodId: string; payoutDate?: string; reference: string }) {
  return await run('refunds:record_manual_payout', { surface: 'finance/refunds/detail', action: 'record_payout' }, async (ctx) => await fin().refunds.recordPayout(ctx, id, { ...input, permissions: await postingPermissions() }), [ROOT, `${ROOT}/${id}`]);
}

/** Sends an approved refund to the customer's phone through M-Pesa. The refund's own approval is the approval for the money. */
export async function payRefundThroughMpesaAction(id: string) {
  return await run('refunds:pay_automatic', { surface: 'finance/refunds/detail', action: 'pay_through_mpesa' }, async (ctx) => {
    const { getContainer } = await import('@/server/di/container');
    const c = getContainer();
    const plan = await c.finance.refunds.prepareAutomatic(ctx, id);
    const { OperationRefused } = await import('@/server/domains/payments/daraja/operations');
    try {
      const r = await c.paymentEngine.disbursements.request({
        companyId: ctx.companyId, providerId: plan.providerId, methodId: plan.methodId, operation: 'b2c', preApproved: true,
        input: { phone: plan.phone, amount: plan.amount.split('.')[0], commandId: 'BusinessPayment', remarks: `Refund ${plan.number}`.slice(0, 100) },
        requestedBy: ctx.actor.id ?? 'system', subject: { type: 'refund', id }, idempotencyKey: `refund:${id}:payout:${plan.attempt}`,
        origin: ctx.origin,
      });
      return { operationId: r.op.id, status: r.status };
    } catch (error) {
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, [ROOT, `${ROOT}/${id}`]);
}

/**
 * Pays an approved refund by reversing the customer's own M-Pesa payment: the money goes back to whoever paid, whole, and cannot go to
 * another phone. The refund's own approval is the approval for the money.
 */
export async function reverseRefundPaymentAction(id: string) {
  return await run('refunds:reverse_payment', { surface: 'finance/refunds/detail', action: 'reverse_payment' }, async (ctx) => {
    const { getContainer } = await import('@/server/di/container');
    const c = getContainer();
    const plan = await c.finance.refunds.prepareReversal(ctx, id);
    const { OperationRefused } = await import('@/server/domains/payments/daraja/operations');
    try {
      const r = await c.paymentEngine.disbursements.request({
        companyId: ctx.companyId, providerId: plan.providerId, methodId: plan.methodId, operation: 'reversal', preApproved: true,
        input: { transactionId: plan.transactionId, amount: plan.amount.split('.')[0], remarks: `Refund ${plan.number}`.slice(0, 100) },
        requestedBy: ctx.actor.id ?? 'system', subject: { type: 'refund', id }, idempotencyKey: `refund:${id}:reversal:${plan.attempt}`,
        origin: ctx.origin,
      });
      return { operationId: r.op.id, status: r.status };
    } catch (error) {
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, [ROOT, `${ROOT}/${id}`]);
}

/** Money from a paid refund came back: record it, and start a replacement refund to details that work. */
export async function recordRefundReturnAction(id: string, input: { amount?: string; returnedOn?: string; reference: string; receivedIntoMethodId: string; reasonCode: string; reasonText?: string; replacement: { paymentMethodId: string; payoutDetails: Record<string, string> } }) {
  return await run('refunds:record_return', { surface: 'finance/refunds/detail', action: 'record_return' }, async (ctx) => {
    return await fin().refunds.recordReturn(ctx, id, { ...input, mayChangeDestination: await canPermission('refunds:change_destination'), permissions: await postingPermissions() });
  }, [ROOT, `${ROOT}/${id}`]);
}

/** A payout that could not be confirmed: ask Safaricom again about its receipt. */
export async function recheckRefundPayoutAction(id: string) {
  return await run('refunds:resolve_payout', { surface: 'finance/refunds/detail', action: 'recheck_payout' }, async (ctx) => {
    const held = await fin().refunds.doubtfulPayout(ctx.companyId, id);
    const out = await getContainer().paymentEngine.recheckPayout(held.id);
    if (!out.ok) throw new FinanceError('RECHECK_REFUSED', out.error);
    await fin().refunds.noteEvent(ctx, id, 'payout_rechecked', { operation: held.id, receipt: held.reference });
    return { operationId: held.id };
  }, [ROOT, `${ROOT}/${id}`]);
}

/** A payout that could not be confirmed, closed by a person who looked at the statement. */
export async function closeRefundPayoutAction(id: string, input: { moneyLeft: boolean; reason: string }) {
  return await run('refunds:resolve_payout', { surface: 'finance/refunds/detail', action: 'close_payout' }, async (ctx) => {
    const held = await fin().refunds.doubtfulPayout(ctx.companyId, id);
    const out = await getContainer().paymentEngine.closeDoubtfulPayout({ opId: held.id, userId: ctx.actor.id ?? 'system', reason: input.reason, moneyLeft: input.moneyLeft });
    if (!out.ok) throw new FinanceError('CLOSE_REFUSED', out.error);
    await fin().refunds.noteEvent(ctx, id, input.moneyLeft ? 'payout_closed_money_left' : 'payout_closed_not_paid', { operation: held.id }, { text: input.reason.trim() });
    return { moneyLeft: input.moneyLeft };
  }, [ROOT, `${ROOT}/${id}`]);
}

export async function listRefundsAction(filter: { status?: RefundStatus; q?: string; before?: string } = {}) {
  return await run('refunds:read', { surface: 'finance/refunds', action: 'list' }, async (ctx) => {
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
  return await run('refunds:read', { surface: 'finance/refunds/detail', action: 'view' }, async (ctx) => {
    const d = await fin().refunds.detail(ctx.companyId, id);
    if (!d) throw new FinanceError('NOT_FOUND', 'That refund does not exist.');
    const media = getContainer().media;
    const payouts = await fin().refunds.payoutAttempts(ctx.companyId, id);
    const reversal = d.r.status === 'approved' ? await fin().refunds.reversalOption(ctx.companyId, id) : null;
    const [returns, replaces, returnable, inFile] = await Promise.all([
      fin().refunds.returnsOf(ctx.companyId, id),
      d.r.sourceKind === 'returned_payout' ? fin().refunds.replacedNumber(ctx.companyId, d.r.sourceId) : Promise.resolve(null),
      d.r.status === 'paid' ? fin().refunds.returnableCents(ctx.companyId, id, d.r.amount) : Promise.resolve(0),
      d.r.status === 'approved' ? fin().refunds.liveFile(ctx.companyId, id) : Promise.resolve(null),
    ]);
    const attachments = await Promise.all(d.attachments.map(async (a) => ({ id: a.id, fileName: a.fileName, note: a.note, createdAt: a.createdAt.toISOString(), url: await media.deliveryUrlById(a.mediaAssetId).catch(() => null) })));
    const r = d.r;
    const name = (x: string | null) => (has(x) ? (d.actors[x] ?? x) : null);
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
      returns: returns.map((x) => ({ id: x.id, amount: x.amount, reference: x.reference, on: x.returnedOn, replacementId: x.replacementRefundId })),
      returnable: fromCents(returnable),
      inFile: inFile === null ? null : { id: inFile.fileId, number: inFile.number },
      replacesNumber: replaces,
      reversal: reversal === null ? null : reversal.ok ? { ok: true as const, transactionId: reversal.original.transactionId } : { ok: false as const, reason: reversal.reason },
      payouts: payouts.map((p) => ({ id: p.id, status: p.status, reference: p.reference, failure: p.failureReason, at: p.createdAt.toISOString() })),
      events: d.events.map((e) => ({ id: String(e.id), event: e.event, from: e.fromStatus, to: e.toStatus, reasonCode: e.reasonCode, reasonText: e.reasonText, by: name(e.actorId) ?? e.actorType, surface: (e.origin as { surface?: string }).surface ?? null, permission: (e.origin as { permissionUsed?: string }).permissionUsed ?? null, at: e.createdAt.toISOString(), data: e.data })),
      can: {
        submit: await canPermission('refunds:submit'),
        cancel: await canPermission('refunds:cancel'),
        pay: await canPermission('refunds:record_manual_payout'),
        payAutomatic: await canPermission('refunds:pay_automatic'),
        reversePayment: await canPermission('refunds:reverse_payment'),
        resolvePayout: await canPermission('refunds:resolve_payout'),
        recordReturn: await canPermission('refunds:record_return'),
        changeDestination: await canPermission('refunds:change_destination'),
        attach: await canPermission('refunds:upload_evidence'),
      },
    };
  });
}

/** The refund report for a period; without one, the last 30 days. */
export async function refundReportAction(period?: { from: string; to: string }) {
  return await run('refunds:read', { surface: 'finance/refunds/report', action: 'view' }, async (ctx) => {
    const { from, to } = period ?? lastDays(new Date(), 30);
    const [rep, recon] = await Promise.all([fin().refunds.report(ctx.companyId, from, to), fin().refunds.payableReconciliation(ctx.companyId)]);
    return {
      from,
      to,
      byStatus: rep.byStatus.map((x) => ({ status: x.status, count: x.n, total: x.total })),
      byReason: rep.byReason.map((x) => ({ reason: x.reason, count: x.n, total: x.total })),
      byMethod: rep.byMethod.map((x) => ({ method: x.method, count: x.n, total: x.total })),
      stuck: rep.stuck.map((x) => ({ id: x.r.id, number: x.r.number, customer: x.customerName, amount: x.r.amount, currency: x.r.currency, approvedAt: x.r.approvedAt ? x.r.approvedAt.toISOString() : null })),
      reconciliation: recon.map((r) => ({ accountNo: r.accountNo, accountName: r.accountName, gl: fromCents(r.glCents), owed: fromCents(r.owedCents), diff: fromCents(r.diffCents) })),
    };
  });
}

export type { RefundSource };

/** The refund limits as they stand, and whether this person may change them. */
export async function refundLimitsAction() {
  return await run('refund_limits:read', { surface: 'finance/refunds/limits', action: 'view' }, async (ctx) => {
    const view = await fin().refundLimits.view(ctx.companyId);
    return { ...view, canManage: await canPermission('refund_limits:manage') };
  });
}

export async function saveRefundLimitsAction(values: RefundLimitValues, expectedVersion: number) {
  return await run(
    'refund_limits:manage',
    { surface: 'finance/refunds/limits', action: 'save' },
    async (ctx) => {
      // Checked here, not trusted from the form: counts and amounts are whole and positive, the window is 1 to 720 hours.
      const { checkLimitsForm } = await import('@/lib/refund-limits-form');
      const f = (n: number | null) => (n === null ? '' : String(n));
      const checked = checkLimitsForm({
        enabled: values.enabled === true,
        windowHours: String(values.windowHours),
        maxPerCustomer: f(values.maxPerCustomer),
        maxAmountPerCustomer: values.maxCentsPerCustomer === null ? '' : fromCents(values.maxCentsPerCustomer),
        maxPerDestination: f(values.maxPerDestination),
        maxPerRequester: f(values.maxPerRequester),
        maxAmountPerRequester: values.maxCentsPerRequester === null ? '' : fromCents(values.maxCentsPerRequester),
        mode: values.mode,
      });
      if (!checked.ok) throw new FinanceError('LIMITS_INVALID', checked.error);
      return await fin().refundLimits.save(ctx, checked.value, expectedVersion);
    },
    [`${ROOT}/limits`],
  );
}
