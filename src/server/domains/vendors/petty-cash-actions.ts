'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { run } from '@/server/domains/finance/action-runner';
import { FinanceError } from '@/server/domains/finance/errors';
import { businessDate } from '@/server/kernel/numbering/business-date';
import type { FloatForm, PettyVoucherForm } from '@/lib/petty-cash';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const id = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new FinanceError('NOT_FOUND', 'That record does not exist.');
  return value;
};
const optionalId = (value: unknown): string => (typeof value === 'string' && value !== '' ? id(value) : '');
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const PATHS = ['/admin/vendors/petty-cash'];

async function flags() {
  const [manage, create, approve, pay, reverse] = await Promise.all([canPermission('petty_cash:manage'), canPermission('petty_cash:create'), canPermission('petty_cash:approve'), canPermission('petty_cash:pay'), canPermission('petty_cash:reverse')]);
  return { manage, create, approve, pay, reverse };
}

export async function pettyFloatsAction() {
  return await run('petty_cash:read', { surface: 'petty_cash/floats', action: 'view' }, async (ctx) => ({ floats: await getContainer().pettyCash.floats(ctx.companyId, businessDate()), can: await flags() }));
}

export async function saveFloatAction(floatId: string | null, form: unknown) {
  return await run('petty_cash:manage', { surface: 'petty_cash/floats', action: floatId === null ? 'create' : 'update' }, async (ctx) => {
    const f = obj(form);
    const clean: FloatForm = { code: str(f.code, 30), name: str(f.name, 150), bankAccountId: optionalId(f.bankAccountId), glAccountId: optionalId(f.glAccountId), custodianId: optionalId(f.custodianId), floatAmount: str(f.floatAmount, 20), perVoucherLimit: str(f.perVoucherLimit, 20), dailyLimit: str(f.dailyLimit, 20), minimumBalance: str(f.minimumBalance, 20) };
    return await getContainer().pettyCash.saveFloat(ctx, floatId === null ? null : id(floatId), clean);
  }, PATHS);
}

export async function setFloatActiveAction(floatId: string, active: boolean) {
  return await run('petty_cash:manage', { surface: 'petty_cash/floats', action: active ? 'switch_on' : 'switch_off' }, async (ctx) => {
    await getContainer().pettyCash.setActive(ctx, id(floatId), active);
  }, PATHS);
}

export async function pettyFloatAction(floatId: string) {
  return await run('petty_cash:read', { surface: 'petty_cash/float', action: 'view' }, async (ctx) => {
    const found = await getContainer().pettyCash.floatDetail(ctx.companyId, id(floatId));
    if (found === null) throw new FinanceError('NOT_FOUND', 'That float does not exist.');
    return { ...found, can: await flags(), me: ctx.actor.id };
  });
}

/** A voucher for reading or editing; with no id, the float a new one is written for. */
export async function pettyVoucherAction(voucherId: string | null, floatId: string | null) {
  return await run('petty_cash:read', { surface: 'petty_cash/voucher', action: 'view' }, async (ctx) => {
    const container = getContainer();
    const found = voucherId === null ? null : await container.pettyCash.voucherDetail(ctx.companyId, id(voucherId));
    if (voucherId !== null && found === null) throw new FinanceError('NOT_FOUND', 'That voucher does not exist.');
    const wanted = found?.voucher.floatId ?? (floatId === null ? null : id(floatId));
    const float = wanted === null ? null : ((await container.pettyCash.floats(ctx.companyId, businessDate())).find((f) => f.id === wanted) ?? null);
    const attachments = await Promise.all((found?.attachments ?? []).map(async (a) => ({ ...a, url: await container.media.deliveryUrlById(a.mediaAssetId).catch(() => null) })));
    return { found: found === null ? null : { ...found, attachments }, float, can: await flags(), me: ctx.actor.id, today: businessDate() };
  });
}

export async function savePettyVoucherAction(voucherId: string | null, form: unknown) {
  return await run('petty_cash:create', { surface: 'petty_cash/voucher', action: voucherId === null ? 'create' : 'update' }, async (ctx) => {
    const f = obj(form);
    const clean: PettyVoucherForm = { floatId: id(f.floatId), kind: f.kind === 'vendor_invoice' ? 'vendor_invoice' : 'expense', payeeName: str(f.payeeName, 150), description: str(f.description, 350), receiptRef: str(f.receiptRef, 80), amount: str(f.amount, 20), expenseAccountId: optionalId(f.expenseAccountId), purchaseInvoiceId: optionalId(f.purchaseInvoiceId) };
    return await getContainer().pettyCash.saveDraft(ctx, voucherId === null ? null : id(voucherId), clean);
  }, PATHS);
}

export async function submitPettyVoucherAction(voucherId: string) {
  return await run('petty_cash:create', { surface: 'petty_cash/voucher', action: 'submit' }, async (ctx) => {
    await getContainer().pettyCash.submit(ctx, id(voucherId));
  }, PATHS);
}

export async function approvePettyVoucherAction(voucherId: string) {
  return await run('petty_cash:approve', { surface: 'petty_cash/voucher', action: 'approve' }, async (ctx) => await getContainer().pettyCash.approve(ctx, id(voucherId)), PATHS);
}

export async function sendBackPettyVoucherAction(voucherId: string, reason: string) {
  return await run('petty_cash:approve', { surface: 'petty_cash/voucher', action: 'send_back' }, async (ctx) => {
    await getContainer().pettyCash.sendBack(ctx, id(voucherId), str(reason));
  }, PATHS);
}

export async function cancelPettyVoucherAction(voucherId: string, reason: string) {
  return await run('petty_cash:create', { surface: 'petty_cash/voucher', action: 'cancel' }, async (ctx) => {
    await getContainer().pettyCash.cancel(ctx, id(voucherId), str(reason));
  }, PATHS);
}

export async function payPettyVoucherAction(voucherId: string) {
  return await run('petty_cash:pay', { surface: 'petty_cash/voucher', action: 'pay' }, async (ctx) => await getContainer().pettyCash.pay(ctx, id(voucherId)), [...PATHS, '/admin/vendors/payables']);
}

export async function reversePettyVoucherAction(voucherId: string, reason: string) {
  return await run('petty_cash:reverse', { surface: 'petty_cash/voucher', action: 'reverse' }, async (ctx) => {
    await getContainer().pettyCash.reverse(ctx, id(voucherId), str(reason));
  }, [...PATHS, '/admin/vendors/payables']);
}

export async function requestTopUpAction(input: unknown) {
  return await run('petty_cash:create', { surface: 'petty_cash/float', action: 'request_top_up' }, async (ctx) => {
    const i = obj(input);
    return await getContainer().pettyCash.requestReplenishment(ctx, { floatId: id(i.floatId), fromMethodId: id(i.fromMethodId), amount: str(i.amount, 20), countNote: str(i.countNote, 400) });
  }, PATHS);
}

export async function approveTopUpAction(topUpId: string) {
  return await run('petty_cash:approve', { surface: 'petty_cash/float', action: 'approve_top_up' }, async (ctx) => {
    await getContainer().pettyCash.approveReplenishment(ctx, id(topUpId));
  }, PATHS);
}

export async function payTopUpAction(topUpId: string, reference: string) {
  return await run('petty_cash:pay', { surface: 'petty_cash/float', action: 'pay_top_up' }, async (ctx) => await getContainer().pettyCash.payReplenishment(ctx, id(topUpId), { reference: str(reference, 120) }), PATHS);
}

export async function cancelTopUpAction(topUpId: string, reason: string) {
  return await run('petty_cash:create', { surface: 'petty_cash/float', action: 'cancel_top_up' }, async (ctx) => {
    await getContainer().pettyCash.cancelReplenishment(ctx, id(topUpId), str(reason));
  }, PATHS);
}
