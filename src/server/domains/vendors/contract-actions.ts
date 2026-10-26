'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { ContractHeaderForm, ContractLineForm } from '@/lib/vendor-contract';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const PATHS = ['/admin/vendors/contracts'];

async function flags() {
  const [create, approve, close, order] = await Promise.all([canPermission('contracts:create'), canPermission('contracts:approve'), canPermission('contracts:close'), canPermission('purchase_orders:create')]);
  return { create, approve, close, callOff: create && order };
}

export async function contractsAction(status?: string) {
  return await run('contracts:read', { surface: 'contracts', action: 'list' }, async (ctx) => ({ rows: await getContainer().contracts.list(ctx.companyId, { status: ['draft', 'pending_approval', 'active', 'closed', 'cancelled'].includes(status ?? '') ? status : undefined }), can: await flags() }));
}

export async function contractAction(contractId: string | null) {
  return await run('contracts:read', { surface: 'contracts', action: 'view' }, async (ctx) => {
    const found = contractId === null ? null : await getContainer().contracts.get(ctx.companyId, id(contractId));
    if (contractId !== null && found === null) throw new FinanceError('NOT_FOUND', 'That contract does not exist.');
    return { found, can: await flags(), me: ctx.actor.id, today: businessDate() };
  });
}

export async function saveContractAction(contractId: string | null, header: unknown, lines: unknown) {
  return await run('contracts:create', { surface: 'contracts', action: contractId === null ? 'create' : 'update' }, async (ctx) => {
    const h = obj(header);
    const clean: ContractHeaderForm = { vendorId: str(h.vendorId, 40), categoryId: str(h.categoryId, 40), title: str(h.title, 200), currency: str(h.currency, 8), validFrom: str(h.validFrom, 12), validTo: str(h.validTo, 12), maxValue: str(h.maxValue, 20), terms: str(h.terms, 4200) };
    const rows: ContractLineForm[] = (Array.isArray(lines) ? lines : []).slice(0, 201).map((l) => {
      const o = obj(l);
      return { productId: str(o.productId, 80), description: str(o.description, 400), specification: str(o.specification, 800), unit: str(o.unit, 24), unitPrice: str(o.unitPrice, 20), discountPercent: str(o.discountPercent, 8), taxRate: str(o.taxRate, 8), maxQuantity: str(o.maxQuantity, 20) };
    });
    return await getContainer().contracts.saveDraft(ctx, contractId === null ? null : id(contractId), clean, rows);
  }, PATHS);
}

export async function submitContractAction(contractId: string) {
  return await run('contracts:create', { surface: 'contracts', action: 'submit' }, async (ctx) => {
    await getContainer().contracts.submit(ctx, id(contractId));
  }, PATHS);
}

export async function approveContractAction(contractId: string) {
  return await run('contracts:approve', { surface: 'contracts', action: 'approve' }, async (ctx) => await getContainer().contracts.approve(ctx, id(contractId)), PATHS);
}

export async function sendBackContractAction(contractId: string, reason: string) {
  return await run('contracts:approve', { surface: 'contracts', action: 'send_back' }, async (ctx) => {
    await getContainer().contracts.sendBack(ctx, id(contractId), str(reason));
  }, PATHS);
}

export async function closeContractAction(contractId: string, reason: string) {
  return await run('contracts:close', { surface: 'contracts', action: 'close' }, async (ctx) => {
    await getContainer().contracts.close(ctx, id(contractId), str(reason));
  }, PATHS);
}

export async function cancelContractAction(contractId: string, reason: string) {
  return await run('contracts:create', { surface: 'contracts', action: 'cancel' }, async (ctx) => {
    await getContainer().contracts.cancel(ctx, id(contractId), str(reason));
  }, PATHS);
}

/** An order called off a contract: lines and quantities only; prices, vendor and currency are the contract's. */
export async function callOffAction(contractId: string, lines: unknown, expectedDate: string, notes: string) {
  return await run('contracts:create', { surface: 'contracts', action: 'call_off' }, async (ctx) => {
    if (!(await canPermission('purchase_orders:create'))) throw new FinanceError('CANNOT_CREATE_ORDER', 'Calling off an order also needs the permission to create orders.');
    const asked = (Array.isArray(lines) ? lines : []).slice(0, 200).map((l) => ({ contractLineId: id(obj(l).contractLineId), quantity: str(obj(l).quantity, 20) }));
    return await getContainer().purchaseOrders.createFromContract(ctx, id(contractId), asked, { expectedDate: str(expectedDate, 12), notes: str(notes, 300) });
  }, [...PATHS, '/admin/vendors/orders']);
}
