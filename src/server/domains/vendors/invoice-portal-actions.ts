'use server';

import { getContainer } from '@/server/di/container';
import { portal } from './portal-runner';
import { ProfileError } from './profile-service';
import type { DeliveryNoteForm, InvoiceHeaderForm, InvoiceLineForm } from '@/lib/supplier-invoice';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProfileError('NOT_FOUND', 'That invoice does not exist.');
  return value;
};
const str = (value: unknown, max = 500): string => (typeof value === 'string' ? value.slice(0, max) : '');
const obj = (value: unknown): Record<string, unknown> => (typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {});
const list = (value: unknown, max: number): unknown[] => (Array.isArray(value) ? value.slice(0, max) : []);

export async function vendorInvoicesAction(before: { createdAt: string; id: string } | null = null) {
  return await portal('invoice_list', async (me) => {
    const cursor = before !== null && typeof before === 'object' && UUID.test(before.id) && before.createdAt.length <= 40 ? { createdAt: before.createdAt, id: before.id } : null;
    return await getContainer().invoicePortal.list(me.vendorId, cursor);
  });
}

export async function invoiceableOrdersAction() {
  return await portal('invoice_orders', async (me) => await getContainer().invoicePortal.orders(me.vendorId));
}

export async function vendorInvoiceAction(invoiceId: string) {
  return await portal('invoice_view', async (me) => await getContainer().invoicePortal.load(me, idOf(invoiceId)));
}

export async function startInvoiceAction(poId: string, vendorInvoiceNo: string) {
  return await portal('invoice_start', async (me) => await getContainer().invoicePortal.start(me, me.companyId, { poId: idOf(poId), vendorInvoiceNo: str(vendorInvoiceNo, 60) }));
}

export async function saveInvoiceAction(invoiceId: string, input: unknown) {
  return await portal('invoice_save', async (me) => {
    const x = obj(input);
    const h = obj(x.header);
    const header: InvoiceHeaderForm = { vendorInvoiceNo: str(h.vendorInvoiceNo, 60), invoiceDate: str(h.invoiceDate, 12), dueDate: str(h.dueDate, 12), notes: str(h.notes, 1100), declaration: h.declaration === true };
    const lines: InvoiceLineForm[] = list(x.lines, 200).map((l) => ({ poLineId: str(obj(l).poLineId, 40), quantity: str(obj(l).quantity, 20), unitPrice: str(obj(l).unitPrice, 20) }));
    const deliveryNotes: DeliveryNoteForm[] = list(x.deliveryNotes, 30).map((n) => ({ noteNo: str(obj(n).noteNo, 60), noteDate: str(obj(n).noteDate, 12), fileId: str(obj(n).fileId, 40) }));
    return await getContainer().invoicePortal.save(me, idOf(invoiceId), { header, lines, deliveryNotes, invoiceFileId: str(x.invoiceFileId, 40) });
  });
}

export async function submitInvoiceAction(invoiceId: string) {
  return await portal('invoice_submit', async (me) => await getContainer().invoicePortal.submit(me, me.companyId, idOf(invoiceId)), 'vendor_submit');
}

export async function recallInvoiceAction(invoiceId: string) {
  return await portal('invoice_recall', async (me) => {
    await getContainer().invoicePortal.recall(me, idOf(invoiceId));
  });
}

export async function closeInvoiceAction(invoiceId: string, reason: string) {
  return await portal('invoice_close', async (me) => {
    await getContainer().invoicePortal.close(me, idOf(invoiceId), str(reason));
  });
}
