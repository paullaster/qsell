'use server';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import { requirePermission } from '@/server/domains/access-control/guard';
import { auth } from '@/auth';
import { taxInvoiceRefusal } from '@/lib/invoice-gate';
import type {
  GeneratedInvoice,
  InvoiceDocumentType,
} from '@/server/domains/invoices/service';

function parseDocumentType(documentType?: InvoiceDocumentType): InvoiceDocumentType {
  if (documentType === 'proforma' || documentType === 'delivery_invoice') return documentType;
  return 'tax_invoice';
}

/**
 * Staff may issue a tax invoice whenever their rules allow. Anyone else (the shopper, who holds only the order's id) may only for an
 * order that was paid, or one whose payment is not due now (on account, pay on delivery), and never for one cancelled or failed.
 */
async function assertMayIssue(orderId: string, documentType: InvoiceDocumentType): Promise<void> {
  if (documentType === 'proforma') return;
  if ((await auth())?.user.isStaff === true) return;
  const order = await getContainer().orders.getById(orderId);
  if (order === null) throw new Error('Order not found');
  const refusal = taxInvoiceRefusal(order);
  if (refusal !== null) throw new Error(refusal);
}

export async function generateInvoicePdfAction(
  orderId: string,
  documentType?: InvoiceDocumentType,
): Promise<GeneratedInvoice> {
  if (orderId === '') throw new Error('orderId is required');
  const { invoices } = getContainer();
  await assertMayIssue(orderId, parseDocumentType(documentType));
  const result = await invoices.generatePdf(orderId, parseDocumentType(documentType));
  revalidatePath('/admin/orders');
  return result;
}

export async function emailInvoiceAction(
  orderId: string,
  documentType?: InvoiceDocumentType,
): Promise<GeneratedInvoice> {
  if (orderId === '') throw new Error('orderId is required');
  const { invoices } = getContainer();
  await assertMayIssue(orderId, parseDocumentType(documentType));
  const result = await invoices.generateAndEmail(orderId, parseDocumentType(documentType));
  revalidatePath('/admin/orders');
  return result;
}

/** Whether this order's delivery has an invoice of its own (the company bills delivery apart from the goods), so the screen can offer it. */
export async function deliveryInvoiceAvailableAction(orderId: string): Promise<{ ok: true; data: { available: boolean } } | { ok: false; error: string }> {
  try {
    await requirePermission('orders:read');
  } catch {
    return { ok: false, error: 'You do not have permission to see orders.' };
  }
  try {
    return { ok: true, data: { available: await getContainer().invoices.hasDeliveryInvoice(orderId) } };
  } catch (error: unknown) {
    console.error('[invoices] delivery invoice available', error);
    return { ok: false, error: 'Could not check the delivery invoice.' };
  }
}
