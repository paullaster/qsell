'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { parseSalesOrderInput } from './domain/sales-order-input';
import type { CreditPosition } from './sales-order-service';

/** Staff: what the company's settings let a direct sales invoice do, so the screen offers only that. */
export async function salesInvoiceBehaviourAction(): Promise<{ ok: true; data: { allowHoldUntilPaid: boolean } } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:create');
  try {
    const c = getContainer();
    const settings = await c.sellingSettings.get((await c.companySettings.ensureSeeded()).id, 'sales_invoice');
    return { ok: true, data: { allowHoldUntilPaid: settings.allowHoldUntilPaid } };
  } catch (error) {
    console.error('[sales invoices] behaviour', error);
    return { ok: false, error: 'The settings for sales invoices could not be read.' };
  }
}

/** Staff: where a customer stands for credit, shown before the invoice is issued (as the settings for sales invoices will look at it). */
export async function salesInvoiceCreditAction(customerId: unknown): Promise<{ ok: true; data: CreditPosition | null } | { ok: false; error: string }> {
  await requirePermission('sales_invoices:create');
  if (typeof customerId !== 'string' || customerId.length === 0 || customerId.length > 40) return { ok: true, data: null };
  try {
    const c = getContainer();
    return { ok: true, data: await c.salesOrders.creditPosition((await c.companySettings.ensureSeeded()).id, customerId, 'sales_invoice') };
  } catch (error) {
    console.error('[sales invoices] credit position', error);
    return { ok: false, error: 'The customer\'s credit position could not be read.' };
  }
}

/** Staff: the builder for a package product on a direct sales invoice: every option can be chosen, the package need not be on the web shop. */
export async function salesInvoicePackageBuilderAction(productId: unknown) {
  await requirePermission('sales_invoices:create');
  if (typeof productId !== 'string' || productId.length === 0 || productId.length > 100) return { ok: true as const, data: null };
  try {
    const c = getContainer();
    return { ok: true as const, data: await c.packageShop.staffBuilder((await c.companySettings.ensureSeeded()).id, productId) };
  } catch (error) {
    console.error('[sales invoices] package builder', error);
    return { ok: false as const, error: 'Could not open the package. Please try again.' };
  }
}

/**
 * Staff: issues a sales invoice directly, with no sales order in front of it. The browser sends ids, counts and choices; the server
 * prices it and applies the company's settings for sales invoices (credit check, credit days, approval, stock release, invoicing).
 */
export async function issueSalesInvoiceAction(raw: unknown): Promise<{ ok: true; data: { orderNumber: string; invoiceNumber: string | null; waitingForApproval: boolean } } | { ok: false; error: string }> {
  const userId = await requirePermission('sales_invoices:create');
  const parsed = parseSalesOrderInput(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    const c = getContainer();
    const company = await c.companySettings.ensureSeeded();
    const placed = await c.salesOrders.place(company.id, { userId, branchId: await c.salesOrders.branchOf(userId) }, parsed.input, 'sales_invoice');
    if (!placed.ok) return { ok: false, error: placed.error };
    // The invoice is made with the document when the company's settings say so (and not while it waits for approval).
    const docs = await c.orderDocuments.of(company.id, placed.orderId);
    revalidatePath('/admin/sales-invoices');
    return { ok: true, data: { orderNumber: placed.orderNumber, invoiceNumber: docs?.invoices.find((i) => i.type === 'tax_invoice')?.number ?? null, waitingForApproval: placed.waitingForApproval } };
  } catch (error) {
    console.error('[sales invoices] issue', error);
    return { ok: false, error: 'The invoice could not be issued just now. Nothing was charged. Please try again.' };
  }
}
