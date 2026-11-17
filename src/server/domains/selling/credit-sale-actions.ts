'use server';

import { revalidatePath } from 'next/cache';
import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { parseSalesOrderInput } from './domain/sales-order-input';
import type { CreditPosition, SalesOrderRow } from './sales-order-service';

const STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

/** Staff: one page of the credit sales (newest first), narrowed by words or status; the request is untrusted. */
export async function creditSalesPageAction(raw: unknown): Promise<{ ok: true; data: { rows: SalesOrderRow[]; nextCursor: string | null; canCreate: boolean } } | { ok: false; error: string }> {
  await requirePermission('credit_sales:read');
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const status = typeof input.status === 'string' && STATUSES.includes(input.status) ? input.status : undefined;
  try {
    const c = getContainer();
    const page = await c.salesOrders.page(
      (await c.companySettings.ensureSeeded()).id,
      { ...(typeof input.query === 'string' ? { query: input.query } : {}), ...(status === undefined ? {} : { status }), cursor: typeof input.cursor === 'string' ? input.cursor : null },
      'credit_sale',
    );
    return { ok: true, data: { ...page, canCreate: await canPermission('credit_sales:create') } };
  } catch (error) {
    console.error('[credit sales] list', error);
    return { ok: false, error: 'The credit sales could not be loaded. Please try again.' };
  }
}

/** Staff: what the company's settings let a credit sale do, so the screen offers only that. */
export async function creditSaleBehaviourAction(): Promise<{ ok: true; data: { allowHoldUntilPaid: boolean } } | { ok: false; error: string }> {
  await requirePermission('credit_sales:create');
  try {
    const c = getContainer();
    const settings = await c.sellingSettings.get((await c.companySettings.ensureSeeded()).id, 'credit_sale');
    return { ok: true, data: { allowHoldUntilPaid: settings.allowHoldUntilPaid } };
  } catch (error) {
    console.error('[credit sales] behaviour', error);
    return { ok: false, error: 'The settings for credit sales could not be read.' };
  }
}

/** Staff: where a customer stands for credit, shown before the sale is placed (as the settings for credit sales will look at it). */
export async function creditSaleCreditAction(customerId: unknown): Promise<{ ok: true; data: CreditPosition | null } | { ok: false; error: string }> {
  await requirePermission('credit_sales:create');
  if (typeof customerId !== 'string' || customerId.length === 0 || customerId.length > 40) return { ok: true, data: null };
  try {
    const c = getContainer();
    return { ok: true, data: await c.salesOrders.creditPosition((await c.companySettings.ensureSeeded()).id, customerId, 'credit_sale') };
  } catch (error) {
    console.error('[credit sales] credit position', error);
    return { ok: false, error: 'The customer\'s credit position could not be read.' };
  }
}

/** Staff: the builder for a package product on a credit sale: every option can be chosen, the package need not be on the web shop. */
export async function creditSalePackageBuilderAction(productId: unknown) {
  await requirePermission('credit_sales:create');
  if (typeof productId !== 'string' || productId.length === 0 || productId.length > 100) return { ok: true as const, data: null };
  try {
    const c = getContainer();
    return { ok: true as const, data: await c.packageShop.staffBuilder((await c.companySettings.ensureSeeded()).id, productId) };
  } catch (error) {
    console.error('[credit sales] package builder', error);
    return { ok: false as const, error: 'Could not open the package. Please try again.' };
  }
}

/**
 * Staff: places a credit sale: a sale to a customer's account, invoiced at once. The browser sends ids, counts and choices; the server
 * prices it and applies the company's settings for credit sales (the credit limit, credit days, approval, stock release, invoicing).
 */
export async function placeCreditSaleAction(raw: unknown): Promise<{ ok: true; data: { orderNumber: string; invoiceNumber: string | null; waitingForApproval: boolean } } | { ok: false; error: string }> {
  const userId = await requirePermission('credit_sales:create');
  const parsed = parseSalesOrderInput(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    const c = getContainer();
    const company = await c.companySettings.ensureSeeded();
    const placed = await c.salesOrders.place(company.id, { userId, branchId: await c.salesOrders.branchOf(userId) }, parsed.input, 'credit_sale');
    if (!placed.ok) return { ok: false, error: placed.error };
    const docs = await c.orderDocuments.of(company.id, placed.orderId);
    revalidatePath('/admin/credit-sales');
    return { ok: true, data: { orderNumber: placed.orderNumber, invoiceNumber: docs?.invoices.find((i) => i.type === 'tax_invoice')?.number ?? null, waitingForApproval: placed.waitingForApproval } };
  } catch (error) {
    console.error('[credit sales] place', error);
    return { ok: false, error: 'The credit sale could not be placed just now. Nothing was charged. Please try again.' };
  }
}
