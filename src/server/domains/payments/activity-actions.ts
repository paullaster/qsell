'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { DARAJA_OPERATIONS, validateOperationInput } from './daraja/catalog';
import { OperationRefused, type DarajaOperationCode } from './daraja/operations';

import { has } from '@/lib/has';

const engine = () => getContainer().paymentEngine;
const PAGE = '/admin/payments/activity';

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export async function paymentActivityAction() {
  return await run('payment_activity:read', { surface: 'payments/activity', action: 'view' }, async (ctx) => {
    const [counts, a] = await Promise.all([engine().activity.counts(ctx.companyId), engine().activity.attention(ctx.companyId)]);
    return {
      counts,
      doubtful: a.doubtful.map((x) => ({ id: x.id, orderNumber: x.orderNumber, amount: x.amount, currency: x.currency, provider: x.providerCode, status: x.status, createdAt: iso(x.createdAt), error: x.errorMessage })),
      events: a.events.map((e) => ({ id: e.id, kind: e.kind, state: e.state, failureCode: e.failureCode, failureReason: e.failureReason, reference: e.platformReference, attemptId: e.attemptId, ip: e.sourceIp, at: iso(e.createdAt) })),
      operations: a.operations.map((o) => ({ id: o.id, operation: o.operation, status: o.status, failureCode: o.failureCode, failureReason: o.failureReason, amount: o.amount, at: iso(o.createdAt) })),
      transactions: a.transactions.map((t) => ({ id: t.id, reference: t.platformReference, state: t.state, amount: t.amount, shortcode: t.shortcode, accountReference: t.accountReference, payer: t.payerMasked, failureCode: t.failureCode, failureReason: t.failureReason, at: iso(t.occurredAt ?? t.createdAt) })),
      can: {
        resolve: await canPermission('payment_activity:resolve'),
        confirm: await canPermission('payments:confirm_unverified'),
      },
    };
  });
}

export async function paymentOperationsAction(before?: string) {
  return await run('payment_activity:read', { surface: 'payments/activity', action: 'operations' }, async (ctx) => {
    const rows = await engine().activity.operations(ctx.companyId, { before });
    return rows.map((r) => ({ id: r.op.id, operation: r.op.operation, status: r.op.status, provider: r.provider, method: r.method, amount: r.op.amount, failureCode: r.op.failureCode, failureReason: r.op.failureReason, attempts: r.op.attempts, platformReference: r.op.platformReference, subject: has(r.op.subjectType) ? r.op.subjectType : null, at: iso(r.op.createdAt), completedAt: iso(r.op.completedAt) }));
  });
}

export async function paymentEventsAction(state?: string, before?: string) {
  return await run('payment_activity:read', { surface: 'payments/activity', action: 'events' }, async (ctx) => {
    const rows = await engine().activity.events(ctx.companyId, { state, before });
    return rows.map((r) => ({ id: r.ev.id, provider: r.provider, kind: r.ev.kind, state: r.ev.state, failureCode: r.ev.failureCode, failureReason: r.ev.failureReason, reference: r.ev.platformReference, amount: r.ev.amount, ip: r.ev.sourceIp, duplicate: r.ev.duplicateOf !== null, attemptId: r.ev.attemptId, at: iso(r.ev.createdAt) }));
  });
}

export async function paymentTransactionsAction(state?: string, before?: string) {
  return await run('payment_activity:read', { surface: 'payments/activity', action: 'transactions' }, async (ctx) => {
    const rows = await engine().activity.transactions(ctx.companyId, { state, before });
    return rows.map((r) => ({ id: r.tx.id, provider: r.provider, method: r.method, kind: r.tx.kind, reference: r.tx.platformReference, state: r.tx.state, amount: r.tx.amount, shortcode: r.tx.shortcode, accountReference: r.tx.accountReference, payer: r.tx.payerMasked, verifiedBy: r.tx.verifiedBy, consumedType: r.tx.consumedType, consumedId: r.tx.consumedId, failureReason: r.tx.failureReason, at: iso(r.tx.occurredAt ?? r.tx.createdAt) }));
  });
}

export async function recheckPaymentAction(attemptId: string) {
  return await run('payment_activity:read', { surface: 'payments/activity', action: 'recheck' }, async () => {
    await engine().recheck(attemptId);
  }, [PAGE]);
}

export async function confirmPaymentAction(attemptId: string, reference: string, reason: string) {
  return await run('payments:confirm_unverified', { surface: 'payments/activity', action: 'confirm_payment' }, async (ctx, userId) => {
    const r = await engine().confirmAttemptManually({ attemptId, reference, reason, userId });
    if (!r.ok) throw new FinanceError('CANNOT_CONFIRM', r.error);
    ctx;
  }, [PAGE]);
}

export async function failPaymentAction(attemptId: string, reason: string) {
  return await run('payments:confirm_unverified', { surface: 'payments/activity', action: 'fail_payment' }, async (_ctx, userId) => {
    const r = await engine().failAttemptManually({ attemptId, reason, userId });
    if (!r.ok) throw new FinanceError('CANNOT_CLOSE', r.error);
  }, [PAGE]);
}

export async function searchCustomersForPlacementAction(q: string) {
  return await run('payment_activity:resolve', { surface: 'payments/activity', action: 'search_customers' }, async (ctx) => await getContainer().finance.receipts.searchCustomers(ctx.companyId, q));
}

export async function placePaymentAction(transactionId: string, customerId: string) {
  return await run('payment_activity:resolve', { surface: 'payments/activity', action: 'place_payment' }, async (_ctx, userId) => {
    const r = await engine().placeTransaction({ transactionId, customerId, userId });
    if (!r.ok) throw new FinanceError('CANNOT_PLACE', r.error);
    return { type: r.type, id: r.id };
  }, [PAGE, '/admin/finance/receipts']);
}

export async function setAsidePaymentAction(transactionId: string, reason: string) {
  return await run('payment_activity:resolve', { surface: 'payments/activity', action: 'set_aside_payment' }, async (_ctx, userId) => {
    const r = await engine().setAsideTransaction({ transactionId, reason, userId });
    if (!r.ok) throw new FinanceError('CANNOT_SET_ASIDE', r.error);
  }, [PAGE]);
}

/** Run one M-Pesa operation by hand (register addresses, check a transaction, make a QR code...). */
export async function runProviderOperationAction(input: { providerId: string; operation: DarajaOperationCode; methodId?: string; input: Record<string, unknown> }) {
  return await run('payment_operations:run', { surface: 'settings/payments', action: `operation_${input.operation}` }, async (ctx, userId) => {
    try {
      const info = DARAJA_OPERATIONS[input.operation];
      if (!info || info.internal === true) throw new OperationRefused('NOT_A_FORM', `${input.operation} is not something to run by hand.`);
      const checked = validateOperationInput(info, input.input);
      if (!checked.ok) throw new OperationRefused('INVALID_INPUT', checked.error);
      const { op } = await engine().daraja.start({ providerId: input.providerId, methodId: input.methodId ?? null, operation: input.operation, input: checked.input, requestedBy: userId, origin: ctx.origin });
      const result = op.result;
      return { id: op.id, status: op.status, failureCode: op.failureCode, failureReason: op.failureReason, qrCode: typeof result.QRCode === 'string' ? result.QRCode : null, detail: JSON.stringify(op.operation === 'qr_generate' ? { ...result, QRCode: '(image)' } : result, null, 2).slice(0, 4000) };
    } catch (error) {
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, ['/admin/settings/payments']);
}

/** Ask for money to be paid out. It waits for approval by someone else; nothing is sent until then. */
export async function requestPayoutAction(input: { providerId: string; methodId: string; operation: DarajaOperationCode; input: Record<string, unknown> }) {
  return await run('payment_operations:request_payout', { surface: 'settings/payments', action: `request_${input.operation}` }, async (ctx, userId) => {
    try {
      const r = await engine().disbursements.request({ companyId: ctx.companyId, providerId: input.providerId, methodId: input.methodId, operation: input.operation, input: input.input, requestedBy: userId, origin: ctx.origin });
      return { id: r.op.id, status: r.status };
    } catch (error) {
      if (error instanceof OperationRefused) throw new FinanceError(error.code, error.message);
      throw error;
    }
  }, ['/admin/settings/payments']);
}

export async function saveProviderSettingsAction(id: string, patch: Record<string, unknown>) {
  return await run('payment_providers:edit', { surface: 'settings/payments', action: 'save_provider_settings' }, async (ctx) => {
    await getContainer().finance.paymentProviders.updateSettings(ctx, id, patch);
  }, ['/admin/settings/payments']);
}

export async function providerOperationLogAction(providerId: string) {
  return await run('payment_activity:read', { surface: 'settings/payments', action: 'operation_log' }, async (ctx) => {
    const rows = await engine().activity.operations(ctx.companyId, { providerId, limit: 15 });
    return rows.map((r) => ({ id: r.op.id, operation: r.op.operation, status: r.op.status, failureReason: r.op.failureReason, at: iso(r.op.createdAt) }));
  });
}
