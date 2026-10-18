'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from './action-runner';
import { FinanceError } from './errors';
import type { AdjustmentInput } from './receivables/credit-adjustment-service';
import type { CreditAdjustmentKind, CreditAdjustmentStatus } from '@/server/db/drizzle/schema';

import { has } from '@/lib/values';

const fin = () => getContainer().finance;
const ROOT = '/admin/finance/receivables/credit-adjustments';

const KIND_CHOICES: Record<string, string> = {
  waive_excess: 'Give up credit the customer is owed',
  wallet_increase: 'Add to the customer\'s wallet',
  wallet_decrease: 'Take off the customer\'s wallet',
};

/** Where "Change a customer's credit" starts: the customer, the credit and the kind when the page was opened from one. */
export async function creditAdjustmentStartAction(customerId?: string, sourceKey?: string, kind?: string, currency?: string) {
  return await run('credit_adjustments:request', { surface: 'finance/credit-adjustments/new', action: 'start' }, async (ctx) => {
    const kindChoice = kind !== undefined && Object.hasOwn(KIND_CHOICES, kind) ? { id: kind, label: KIND_CHOICES[kind] } : null;
    const wallet = currency !== undefined && /^[A-Za-z]{3}$/.test(currency) ? currency.toUpperCase() : '';
    if (customerId === undefined) return { customer: null, source: null, kind: kindChoice, currency: wallet };
    const [brief, obligations] = await Promise.all([fin().refunds.customerBrief(ctx.companyId, customerId), fin().refunds.obligations(ctx.companyId, customerId)]);
    const chosen = sourceKey === undefined ? undefined : obligations.find((o) => `${o.kind}:${o.id}` === sourceKey && (o.kind === 'credit_note_excess' || o.kind === 'receipt_unapplied'));
    return {
      customer: brief === null ? null : { id: customerId, label: brief.name, meta: { phone: brief.phone ?? '' } },
      source: chosen === undefined ? null : { id: `${chosen.kind}:${chosen.id}`, label: chosen.label, meta: { kind: chosen.kind, sourceId: chosen.id, currency: chosen.currency, available: (chosen.availableCents / 100).toFixed(2) } },
      kind: chosen === undefined ? kindChoice : { id: 'waive_excess', label: KIND_CHOICES.waive_excess },
      currency: wallet,
    };
  });
}

/** Asks for a credit adjustment and sends it on: for approval when a workflow covers it, otherwise to a person who can decide. */
export async function requestCreditAdjustmentAction(input: AdjustmentInput) {
  return await run('credit_adjustments:request', { surface: 'finance/credit-adjustments/new', action: 'request' }, async (ctx) => {
    const created = await fin().creditAdjustments.request(ctx, input);
    const sent = await fin().creditAdjustments.submit({ ...ctx, origin: { ...ctx.origin, action: 'submit' } }, created.id);
    return { ...created, status: sent.status };
  }, [ROOT, '/admin/finance/receivables/wallets']);
}

export async function decideCreditAdjustmentAction(id: string, decision: 'approve' | 'reject', note?: string) {
  return await run('credit_adjustments:decide', { surface: 'finance/credit-adjustments/detail', action: decision }, async (ctx) => {
    return await fin().creditAdjustments.decide(ctx, id, decision, note);
  }, [ROOT, `${ROOT}/${id}`, '/admin/finance/receivables/wallets', '/admin/finance/refunds']);
}

export async function cancelCreditAdjustmentAction(id: string, reason: { code: string; text?: string }) {
  return await run('credit_adjustments:cancel', { surface: 'finance/credit-adjustments/detail', action: 'cancel' }, async (ctx) => {
    await fin().creditAdjustments.cancel(ctx, id, reason);
    return { id };
  }, [ROOT, `${ROOT}/${id}`]);
}

export async function listCreditAdjustmentsAction(filter: { status?: CreditAdjustmentStatus; kind?: CreditAdjustmentKind; q?: string; before?: string } = {}) {
  return await run('credit_adjustments:read', { surface: 'finance/credit-adjustments', action: 'list' }, async (ctx) => {
    const page = await fin().creditAdjustments.list(ctx.companyId, filter);
    return {
      nextBefore: page.nextBefore,
      rows: page.rows.map((x) => ({
        id: x.a.id,
        number: x.a.number,
        kind: x.a.kind,
        status: x.a.status,
        amount: x.a.amount,
        currency: x.a.currency,
        customerId: x.a.customerId,
        customer: x.customerName,
        customerNumber: x.customerNumber,
        reason: x.a.reasonCode,
        createdAt: x.a.createdAt.toISOString(),
      })),
      can: { request: await canPermission('credit_adjustments:request') },
    };
  });
}

export async function creditAdjustmentDetailAction(id: string) {
  return await run('credit_adjustments:read', { surface: 'finance/credit-adjustments/detail', action: 'view' }, async (ctx) => {
    const d = await fin().creditAdjustments.detail(ctx.companyId, id);
    if (!d) throw new FinanceError('NOT_FOUND', 'That credit adjustment does not exist.');
    const a = d.a;
    const name = (x: string | null) => (has(x) ? (d.actors[x] ?? x) : null);
    const mine = ctx.actor.id;
    return {
      id: a.id,
      number: a.number,
      kind: a.kind,
      status: a.status,
      amount: a.amount,
      currency: a.currency,
      customer: { id: d.customer.id, name: d.customer.name, number: d.customer.number },
      source: d.sourceLabel,
      reason: a.reasonCode,
      reasonText: a.reasonText,
      requestedBy: name(a.requestedBy),
      decidedBy: name(a.decidedBy),
      decidedAt: a.decidedAt ? a.decidedAt.toISOString() : null,
      events: d.events.map((e) => ({ id: String(e.id), event: e.event, from: e.fromStatus, to: e.toStatus, reasonCode: e.reasonCode, reasonText: e.reasonText, by: name(e.actorId) ?? e.actorType, surface: (e.origin as { surface?: string }).surface ?? null, permission: (e.origin as { permissionUsed?: string }).permissionUsed ?? null, at: e.createdAt.toISOString(), data: e.data })),
      can: {
        decide: d.capabilities.decide && a.requestedBy !== mine && (await canPermission('credit_adjustments:decide')),
        cancel: d.capabilities.cancel && (await canPermission('credit_adjustments:cancel')),
      },
    };
  });
}

/** Wallet balances that lapsed or are about to, soonest first. */
export async function expiringBalancesAction() {
  return await run('wallet:read', { surface: 'finance/wallets', action: 'expiring' }, async (ctx) => {
    const rows = await fin().creditAdjustments.expiringSoon(ctx.companyId, new Date());
    return { rows };
  });
}
