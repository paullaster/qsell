'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { RequisitionHeaderForm, RequisitionLineForm } from '@/lib/purchase-requisition';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const PATHS = ['/admin/vendors/requisitions'];

async function flags() {
  const [create, approve, convert, rfq, order] = await Promise.all([canPermission('requisitions:create'), canPermission('requisitions:approve'), canPermission('requisitions:convert'), canPermission('rfq:create'), canPermission('purchase_orders:create')]);
  return { create, approve, convert, toRfq: convert && rfq, toOrder: convert && order };
}

export async function requisitionsAction(status?: string) {
  return await run('requisitions:read', { surface: 'requisitions', action: 'list' }, async (ctx) => ({ rows: await getContainer().requisitions.list(ctx.companyId, { status: ['draft', 'submitted', 'approved', 'rejected', 'converted', 'cancelled'].includes(status ?? '') ? status : undefined }), can: await flags() }));
}

/** One requisition for reading or editing; with no id, a blank one. */
export async function requisitionAction(requisitionId: string | null) {
  return await run('requisitions:read', { surface: 'requisitions', action: 'view' }, async (ctx) => {
    const found = requisitionId === null ? null : await getContainer().requisitions.get(ctx.companyId, id(requisitionId));
    if (requisitionId !== null && found === null) throw new FinanceError('NOT_FOUND', 'That requisition does not exist.');
    return { found, can: await flags(), me: ctx.actor.id, today: businessDate() };
  });
}

export async function saveRequisitionAction(requisitionId: string | null, header: unknown, lines: unknown) {
  return await run('requisitions:create', { surface: 'requisitions', action: requisitionId === null ? 'create' : 'update' }, async (ctx) => {
    const h = obj(header);
    const clean: RequisitionHeaderForm = { title: str(h.title, 200), purpose: str(h.purpose, 1200), categoryId: str(h.categoryId, 40), currency: str(h.currency, 8), neededBy: str(h.neededBy, 12) };
    const rows: RequisitionLineForm[] = (Array.isArray(lines) ? lines : []).slice(0, 101).map((l) => {
      const o = obj(l);
      return { productId: str(o.productId, 80), description: str(o.description, 400), specification: str(o.specification, 800), quantity: str(o.quantity, 20), unit: str(o.unit, 24), estimatedUnitPrice: str(o.estimatedUnitPrice, 20) };
    });
    return await getContainer().requisitions.saveDraft(ctx, requisitionId === null ? null : id(requisitionId), clean, rows);
  }, PATHS);
}

export async function submitRequisitionAction(requisitionId: string) {
  return await run('requisitions:create', { surface: 'requisitions', action: 'submit' }, async (ctx) => await getContainer().requisitions.submit(ctx, id(requisitionId)), PATHS);
}

export async function approveRequisitionAction(requisitionId: string) {
  return await run('requisitions:approve', { surface: 'requisitions', action: 'approve' }, async (ctx) => {
    await getContainer().requisitions.approve(ctx, id(requisitionId));
  }, PATHS);
}

export async function rejectRequisitionAction(requisitionId: string, reason: string, sendBack: boolean) {
  return await run('requisitions:approve', { surface: 'requisitions', action: sendBack ? 'send_back' : 'reject' }, async (ctx) => {
    await getContainer().requisitions.reject(ctx, id(requisitionId), str(reason), sendBack);
  }, PATHS);
}

export async function cancelRequisitionAction(requisitionId: string, reason: string) {
  return await run('requisitions:create', { surface: 'requisitions', action: 'cancel' }, async (ctx) => {
    await getContainer().requisitions.cancel(ctx, id(requisitionId), str(reason));
  }, PATHS);
}

export async function convertToRfqAction(requisitionId: string, deadline: string) {
  return await run('requisitions:convert', { surface: 'requisitions', action: 'to_rfq' }, async (ctx) => {
    if (!(await canPermission('rfq:create'))) throw new FinanceError('CANNOT_CREATE_RFQ', 'Making a request for quotation also needs the permission to create them.');
    return await getContainer().requisitions.convertToRfq(ctx, id(requisitionId), { deadline: str(deadline, 20) });
  }, [...PATHS, '/admin/vendors/rfqs']);
}

export async function convertToOrderAction(requisitionId: string, vendorId: string) {
  return await run('requisitions:convert', { surface: 'requisitions', action: 'to_order' }, async (ctx) => {
    if (!(await canPermission('purchase_orders:create'))) throw new FinanceError('CANNOT_CREATE_ORDER', 'Making an order also needs the permission to create orders.');
    return await getContainer().requisitions.convertToOrder(ctx, id(requisitionId), { vendorId: id(vendorId) });
  }, [...PATHS, '/admin/vendors/orders']);
}
