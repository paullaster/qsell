'use server';

import { getContainer } from '@/server/di/container';
import { idOf, objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { DocRefusal, DocResult } from './documents';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', not_allowed: 'NOT_ALLOWED', conflict: 'CONFLICT', order_not_ready: 'NOT_ALLOWED', nothing_left: 'BAD_INPUT', wrong_method: 'BAD_INPUT' };

function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const PATHS = ['/admin/delivery/courier-invoices'];
const PERMISSION = 'delivery_costs:manage';

/** The courier invoices (one page), and the courier charges that are on no invoice yet. */
export async function courierInvoicesScreenAction(raw?: unknown) {
  return await runDelivery(PERMISSION, async (ctx) => {
    const c = getContainer().courierInvoices;
    const [page, unbilled] = await Promise.all([c.list(ctx.companyId, objectOf(raw)), c.unbilled(ctx.companyId)]);
    return { ...page, unbilled };
  });
}

export async function courierInvoicesPageAction(raw?: unknown) {
  return await runDelivery(PERMISSION, async (ctx) => await getContainer().courierInvoices.list(ctx.companyId, objectOf(raw)));
}

export async function addCourierInvoiceAction(raw: unknown) {
  return await runDelivery(PERMISSION, async (ctx) => dataOf(await getContainer().courierInvoices.add({ companyId: ctx.companyId, userId: ctx.userId }, objectOf(raw))), PATHS);
}

/** One invoice's matched charges and the charges that could still go on it. */
export async function courierInvoiceChargesAction(invoiceId: unknown) {
  return await runDelivery(PERMISSION, async (ctx) => {
    const id = idOf(invoiceId, 'invoice');
    const c = getContainer().courierInvoices;
    const [matched, candidates] = await Promise.all([c.matchedCharges(ctx.companyId, id), c.candidates(ctx.companyId, id)]);
    return { matched, candidates: candidates.rows, more: candidates.more };
  });
}

export async function matchCourierChargesAction(raw: unknown) {
  return await runDelivery(PERMISSION, async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().courierInvoices.match({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.invoiceId, 'invoice'), i));
  }, PATHS);
}

export async function unmatchCourierChargeAction(raw: unknown) {
  return await runDelivery(PERMISSION, async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().courierInvoices.unmatch({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.invoiceId, 'invoice'), i));
  }, PATHS);
}

export async function voidCourierInvoiceAction(raw: unknown) {
  return await runDelivery(PERMISSION, async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().courierInvoices.voidInvoice({ companyId: ctx.companyId, userId: ctx.userId }, idOf(i.invoiceId, 'invoice'), i));
  }, PATHS);
}
