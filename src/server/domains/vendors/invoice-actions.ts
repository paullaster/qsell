'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import type { LinksInput } from './invoice-service';
import { has } from '@/lib/values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const list = (value: unknown, max = 300): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);
const PATHS = ['/admin/vendors/invoices'];

export async function invoiceQueueAction(filter: { state?: string; vendorId?: string; mine?: boolean; before?: { stamp: string; id: string } | null } = {}) {
  return await run('supplier_invoices:read', { surface: 'invoices/queue', action: 'view' }, async (ctx) => {
    const before = filter.before !== undefined && filter.before !== null && UUID.test(filter.before.id) && filter.before.stamp.length <= 40 ? filter.before : null;
    return await getContainer().supplierInvoices.queue(ctx.companyId, {
      state: has(filter.state) ? str(filter.state, 20) : undefined,
      vendorId: has(filter.vendorId) && UUID.test(filter.vendorId) ? filter.vendorId : undefined,
      assignedTo: filter.mine === true ? (ctx.actor.id ?? undefined) : undefined,
      before,
    });
  });
}

export async function invoiceCountsAction() {
  return await run('supplier_invoices:read', { surface: 'invoices/queue', action: 'counts' }, async (ctx) => await getContainer().supplierInvoices.countsByState(ctx.companyId));
}

/** The workspace for one invoice, with what the viewer is allowed to do with it. */
export async function invoiceAction(invoiceId: string) {
  return await run('supplier_invoices:read', { surface: 'invoices/view', action: 'view' }, async (ctx) => {
    const found = await getContainer().supplierInvoices.get(ctx.companyId, id(invoiceId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That invoice does not exist.');
    const [process, override, ret, reject, approve, post, pay, applyAdvance] = await Promise.all([
      canPermission('supplier_invoices:process'),
      canPermission('supplier_invoices:override_match'),
      canPermission('supplier_invoices:return'),
      canPermission('supplier_invoices:reject'),
      canPermission('supplier_invoices:approve'),
      canPermission('purchase_invoices:post'),
      canPermission('vendor_payments:create'),
      canPermission('vendor_payments:apply_advance'),
    ]);
    const me = ctx.actor.id;
    const separate = me === null || (me !== found.invoice.linkedBy && me !== found.invoice.matchedBy);
    return { ...found, can: { process, override, return: ret, reject, approve: approve && separate, approveBlockedBySeparation: approve && !separate, post, pay, applyAdvance } };
  });
}

export async function pickUpInvoiceAction(invoiceId: string) {
  return await run('supplier_invoices:process', { surface: 'invoices/workspace', action: 'pick_up' }, async (ctx) => {
    await getContainer().supplierInvoices.pickUp(ctx, id(invoiceId));
  }, PATHS);
}

export async function saveInvoiceLinksAction(invoiceId: string, input: unknown) {
  return await run('supplier_invoices:process', { surface: 'invoices/workspace', action: 'link' }, async (ctx) => {
    const x = obj(input);
    const clean: LinksInput = {
      links: list(x.links).map((l) => ({ lineId: id(obj(l).lineId), rgnLineId: id(obj(l).rgnLineId), quantity: str(obj(l).quantity, 20) })),
      accounts: list(x.accounts).map((a) => ({ lineId: id(obj(a).lineId), glAccountId: has(str(obj(a).glAccountId, 40)) ? id(obj(a).glAccountId) : null })),
      notes: list(x.notes, 50).map((n) => ({ noteId: id(obj(n).noteId), rgnId: has(str(obj(n).rgnId, 40)) ? id(obj(n).rgnId) : null })),
    };
    return await getContainer().supplierInvoices.saveLinks(ctx, id(invoiceId), clean);
  }, PATHS);
}

export async function autoLinkInvoiceAction(invoiceId: string) {
  return await run('supplier_invoices:process', { surface: 'invoices/workspace', action: 'auto_link' }, async (ctx) => await getContainer().supplierInvoices.autoLink(ctx, id(invoiceId)), PATHS);
}

export async function matchInvoiceAction(invoiceId: string) {
  return await run('supplier_invoices:process', { surface: 'invoices/workspace', action: 'match' }, async (ctx) => await getContainer().supplierInvoices.runMatch(ctx, id(invoiceId)), PATHS);
}

export async function overrideInvoiceMatchAction(invoiceId: string, reason: string) {
  return await run('supplier_invoices:override_match', { surface: 'invoices/workspace', action: 'override' }, async (ctx) => {
    await getContainer().supplierInvoices.override(ctx, id(invoiceId), str(reason));
  }, PATHS);
}

export async function sendInvoiceForApprovalAction(invoiceId: string) {
  return await run('supplier_invoices:process', { surface: 'invoices/workspace', action: 'send_for_approval' }, async (ctx) => {
    await getContainer().supplierInvoices.sendForApproval(ctx, id(invoiceId));
  }, PATHS);
}

export async function approveInvoiceAction(invoiceId: string) {
  return await run('supplier_invoices:approve', { surface: 'invoices/workspace', action: 'approve' }, async (ctx) => {
    await getContainer().supplierInvoices.approve(ctx, id(invoiceId));
  }, PATHS);
}

export async function returnInvoiceAction(invoiceId: string, reasonCode: string, note: string) {
  return await run('supplier_invoices:return', { surface: 'invoices/workspace', action: 'return' }, async (ctx) => {
    await getContainer().supplierInvoices.returnToVendor(ctx, id(invoiceId), str(reasonCode, 30), str(note));
  }, PATHS);
}

export async function rejectInvoiceAction(invoiceId: string, reasonCode: string, note: string) {
  return await run('supplier_invoices:reject', { surface: 'invoices/workspace', action: 'reject' }, async (ctx) => {
    await getContainer().supplierInvoices.reject(ctx, id(invoiceId), str(reasonCode, 30), str(note));
  }, PATHS);
}

export async function postInvoiceAction(invoiceId: string) {
  return await run('purchase_invoices:post', { surface: 'invoices/workspace', action: 'post' }, async (ctx) => await getContainer().invoicePosting.post(ctx, id(invoiceId)), [...PATHS, '/admin/vendors/orders']);
}
