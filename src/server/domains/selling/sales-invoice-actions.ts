'use server';

import { revalidatePath } from 'next/cache';
import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { isInvoiceKind, isListKind } from './domain/invoice-status';
import type { SalesInvoiceDetail, SalesInvoiceRow } from './sales-invoice-service';

const ORDER_ID = /^[A-Za-z0-9_-]{1,100}$/;
const NUMBER = /^[A-Za-z0-9._/-]{1,80}$/;
const PATH = '/admin/sales-invoices';

/** Staff: one page of invoices (newest first), narrowed by words or kind; the request is untrusted. */
export async function salesInvoicesPageAction(raw: unknown): Promise<{ ok: true; data: { rows: SalesInvoiceRow[]; nextCursor: string | null; canCreate: boolean; canSend: boolean } } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:read');
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  try {
    const page = await getContainer().salesInvoices.page({
      ...(typeof input.query === 'string' ? { query: input.query } : {}),
      ...(isListKind(input.kind) ? { kind: input.kind } : {}),
      cursor: typeof input.cursor === 'string' ? input.cursor : null,
    });
    return { ok: true, data: { ...page, canCreate: await canPermission('sales_invoices:create'), canSend: await canPermission('sales_invoices:send') } };
  } catch (error) {
    console.error('[sales invoices] list', error);
    return { ok: false, error: 'The invoices could not be loaded. Please try again.' };
  }
}

/** Staff: one invoice with its order, credit notes, signing log and lines. */
export async function salesInvoiceDetailAction(invoiceNumber: unknown): Promise<{ ok: true; data: SalesInvoiceDetail | null } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:read');
  if (typeof invoiceNumber !== 'string' || !NUMBER.test(invoiceNumber)) return { ok: true, data: null };
  try {
    return { ok: true, data: await getContainer().salesInvoices.detail(invoiceNumber) };
  } catch (error) {
    console.error('[sales invoices] detail', error);
    return { ok: false, error: 'The invoice could not be loaded. Please try again.' };
  }
}

/** Staff: raises the tax invoice of an order that has none. The rules of invoicing hold (not before approval, a gap-free number). */
export async function raiseSalesInvoiceAction(orderId: unknown): Promise<{ ok: true; data: { invoiceNumber: string; orderNumber: string } } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:create');
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId)) return { ok: false, error: 'Choose the order.' };
  const made = await getContainer().salesInvoices.raise(orderId);
  if (!made.ok) return { ok: false, error: made.error };
  revalidatePath(PATH);
  return { ok: true, data: { invoiceNumber: made.invoiceNumber, orderNumber: made.orderNumber } };
}

/** Staff: sends an invoice to the customer again by email. */
export async function sendSalesInvoiceAction(orderId: unknown, kind: unknown): Promise<{ ok: true; data: { invoiceNumber: string; emailed: boolean } } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:send');
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId) || !isInvoiceKind(kind)) return { ok: false, error: 'That invoice could not be found.' };
  try {
    const sent = await getContainer().salesInvoices.send(orderId, kind);
    revalidatePath(PATH);
    return { ok: true, data: { invoiceNumber: sent.invoiceNumber, emailed: sent.emailed === true } };
  } catch (error) {
    const text = error instanceof Error ? error.message : '';
    console.error('[sales invoices] send', orderId, error);
    return { ok: false, error: /email/i.test(text) && text.length < 160 ? text : 'The invoice could not be sent just now. Please try again.' };
  }
}

/** Staff: the invoice's PDF to print or download. */
export async function salesInvoicePdfAction(orderId: unknown, kind: unknown): Promise<{ ok: true; data: { filename: string; pdfBase64: string } } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:send');
  if (typeof orderId !== 'string' || !ORDER_ID.test(orderId) || !isInvoiceKind(kind)) return { ok: false, error: 'That invoice could not be found.' };
  try {
    const made = await getContainer().salesInvoices.pdf(orderId, kind);
    return { ok: true, data: { filename: made.filename, pdfBase64: made.pdfBase64 } };
  } catch (error) {
    console.error('[sales invoices] pdf', orderId, error);
    return { ok: false, error: 'The invoice could not be opened just now. Please try again.' };
  }
}
