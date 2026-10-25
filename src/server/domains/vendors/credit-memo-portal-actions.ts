'use server';

import { getContainer } from '@/server/di/container';
import { portal } from './portal-runner';
import { ProfileError } from './profile-service';
import type { CreditHeaderForm, CreditLineForm } from '@/lib/vendor-credit-memo';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProfileError('NOT_FOUND', 'That credit note does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});

export async function vendorCreditsAction(before: { createdAt: string; id: string } | null = null) {
  return await portal('credit_list', async (me) => {
    const cursor = before !== null && typeof before === 'object' && UUID.test(before.id) && before.createdAt.length <= 40 ? { createdAt: before.createdAt, id: before.id } : null;
    return await getContainer().creditMemoPortal.list(me.vendorId, cursor);
  });
}

export async function creditableInvoicesAction() {
  return await portal('credit_invoices', async (me) => await getContainer().creditMemoPortal.invoices(me.vendorId));
}

export async function vendorCreditAction(memoId: string) {
  return await portal('credit_view', async (me) => await getContainer().creditMemoPortal.load(me, idOf(memoId)));
}

export async function startCreditAction(purchaseInvoiceId: string, vendorCreditNo: string) {
  return await portal('credit_start', async (me) => await getContainer().creditMemoPortal.start(me, me.companyId, { purchaseInvoiceId: idOf(purchaseInvoiceId), vendorCreditNo: str(vendorCreditNo, 60) }));
}

export async function saveCreditAction(memoId: string, input: unknown) {
  return await portal('credit_save', async (me) => {
    const x = obj(input);
    const h = obj(x.header);
    const header: CreditHeaderForm = { vendorCreditNo: str(h.vendorCreditNo, 60), creditDate: str(h.creditDate, 12), reason: str(h.reason, 600), notes: str(h.notes, 1100) };
    const lines: CreditLineForm[] = (Array.isArray(x.lines) ? x.lines.slice(0, 200) : []).map((l) => ({ invoiceLineId: str(obj(l).invoiceLineId, 40), mode: obj(l).mode === 'price' ? 'price' : 'quantity', quantity: str(obj(l).quantity, 20), unitPrice: str(obj(l).unitPrice, 20) }));
    return await getContainer().creditMemoPortal.save(me, idOf(memoId), { header, lines, fileId: str(x.fileId, 40) });
  });
}

export async function submitCreditAction(memoId: string) {
  return await portal('credit_submit', async (me) => await getContainer().creditMemoPortal.submit(me, me.companyId, idOf(memoId)), 'vendor_submit');
}

export async function recallCreditAction(memoId: string) {
  return await portal('credit_recall', async (me) => {
    await getContainer().creditMemoPortal.recall(me, idOf(memoId));
  });
}

export async function closeCreditAction(memoId: string, reason: string) {
  return await portal('credit_close', async (me) => {
    await getContainer().creditMemoPortal.close(me, idOf(memoId), str(reason));
  });
}
