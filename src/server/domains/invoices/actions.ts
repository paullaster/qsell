'use server';

import { revalidatePath } from 'next/cache';
import { getContainer } from '@/server/di/container';
import type {
  GeneratedInvoice,
  InvoiceDocumentType,
} from '@/server/domains/invoices/service';

function parseDocumentType(documentType?: InvoiceDocumentType): InvoiceDocumentType {
  return documentType === 'proforma' ? 'proforma' : 'tax_invoice';
}

export async function generateInvoicePdfAction(
  orderId: string,
  documentType?: InvoiceDocumentType,
): Promise<GeneratedInvoice> {
  if (!orderId) throw new Error('orderId is required');
  const { invoices } = getContainer();
  const result = await invoices.generatePdf(orderId, parseDocumentType(documentType));
  revalidatePath('/admin/orders');
  return result;
}

export async function emailInvoiceAction(
  orderId: string,
  documentType?: InvoiceDocumentType,
): Promise<GeneratedInvoice> {
  if (!orderId) throw new Error('orderId is required');
  const { invoices } = getContainer();
  const result = await invoices.generateAndEmail(orderId, parseDocumentType(documentType));
  revalidatePath('/admin/orders');
  return result;
}
