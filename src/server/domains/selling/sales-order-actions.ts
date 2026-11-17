'use server';

import { revalidatePath } from 'next/cache';
import { canPermission, requirePermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import { parseSalesOrderInput } from './domain/sales-order-input';
import type { CreditPosition, SalesOrderRow } from './sales-order-service';

const STATUSES = ['pending', 'processing', 'shipped', 'delivered', 'cancelled'];

/** Staff: one page of the sales orders taken (newest first), narrowed by words or status; the request is untrusted. */
export async function salesOrdersPageAction(raw: unknown): Promise<{ ok: true; data: { rows: SalesOrderRow[]; nextCursor: string | null; canCreate: boolean } } | { ok: false; error: string }> {
  await requirePermission('sales_orders:read');
  const input = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const status = typeof input.status === 'string' && STATUSES.includes(input.status) ? input.status : undefined;
  try {
    const c = getContainer();
    const page = await c.salesOrders.page((await c.companySettings.ensureSeeded()).id, {
      ...(typeof input.query === 'string' ? { query: input.query } : {}),
      ...(status === undefined ? {} : { status }),
      cursor: typeof input.cursor === 'string' ? input.cursor : null,
    });
    return { ok: true, data: { ...page, canCreate: await canPermission('sales_orders:create') } };
  } catch (error) {
    console.error('[sales orders] list', error);
    return { ok: false, error: 'The sales orders could not be loaded. Please try again.' };
  }
}

/** Staff: what the company's settings let a sales order do, so the editor offers only that (today: whether one document may be held until it is paid). */
export async function salesOrderBehaviourAction(): Promise<{ ok: true; data: { allowHoldUntilPaid: boolean; discounts: boolean } } | { ok: false; error: string }> {
  await requirePermission('sales_orders:create');
  try {
    const c = getContainer();
    const settings = await c.sellingSettings.get((await c.companySettings.ensureSeeded()).id, 'sales_order');
    return { ok: true, data: { allowHoldUntilPaid: settings.allowHoldUntilPaid, discounts: settings.discounts === 'allowed' } };
  } catch (error) {
    console.error('[sales orders] behaviour', error);
    return { ok: false, error: 'The settings for sales orders could not be read.' };
  }
}

/** Staff: where a customer stands for credit, shown before the order is placed. */
export async function salesOrderCreditAction(customerId: unknown): Promise<{ ok: true; data: CreditPosition | null } | { ok: false; error: string }> {
  await requirePermission('sales_orders:create');
  if (typeof customerId !== 'string' || customerId.length === 0 || customerId.length > 40) return { ok: true, data: null };
  try {
    const c = getContainer();
    return { ok: true, data: await c.salesOrders.creditPosition((await c.companySettings.ensureSeeded()).id, customerId) };
  } catch (error) {
    console.error('[sales orders] credit position', error);
    return { ok: false, error: 'The customer\'s credit position could not be read.' };
  }
}

/** Staff: the builder for a package product on a sales order: every option can be chosen, the package need not be on the web shop. */
export async function salesOrderPackageBuilderAction(productId: unknown) {
  await requirePermission('sales_orders:create');
  if (typeof productId !== 'string' || productId.length === 0 || productId.length > 100) return { ok: true as const, data: null };
  try {
    const c = getContainer();
    return { ok: true as const, data: await c.packageShop.staffBuilder((await c.companySettings.ensureSeeded()).id, productId) };
  } catch (error) {
    console.error('[sales orders] package builder', error);
    return { ok: false as const, error: 'Could not open the package. Please try again.' };
  }
}

/** Staff: places a sales order. The browser sends ids, counts and choices; the server prices it and applies the company's settings. */
export async function placeSalesOrderAction(raw: unknown): Promise<{ ok: true; data: { orderId: string; orderNumber: string; waitingForApproval: boolean } } | { ok: false; error: string }> {
  const userId = await requirePermission('sales_orders:create');
  const parsed = parseSalesOrderInput(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    const c = getContainer();
    const company = await c.companySettings.ensureSeeded();
    const placed = await c.salesOrders.place(company.id, { userId, branchId: await c.salesOrders.branchOf(userId) }, parsed.input);
    if (!placed.ok) return { ok: false, error: placed.error };
    revalidatePath('/admin/sales-orders');
    return { ok: true, data: { orderId: placed.orderId, orderNumber: placed.orderNumber, waitingForApproval: placed.waitingForApproval } };
  } catch (error) {
    console.error('[sales orders] place', error);
    return { ok: false, error: 'The order could not be placed just now. Nothing was charged. Please try again.' };
  }
}
