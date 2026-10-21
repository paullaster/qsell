'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { OrdersService } from './service';
import { resubmitOrderForApproval } from './approval';
import { getContainer } from '@/server/di/container';
import type { Order, OrderStatus, PaymentProvider } from '@/types/index';
import { ORDER_STATUSES } from '@/lib/order-admin';

export async function listOrdersAction(): Promise<Order[]> {
  await requirePermission('orders:read');
  return getContainer().orders.listAll();
}

/** One page of orders for the admin screen, newest first: search by text and narrow by status. Failures come back as data. */
export async function ordersPageAction(input: { query?: string; status?: string | null; cursor?: string | null }): Promise<
  { ok: true; data: { rows: Order[]; nextCursor: string | null } } | { ok: false; error: string }
> {
  try {
    await requirePermission('orders:read');
  } catch {
    return { ok: false, error: 'You do not have permission to see orders.' };
  }
  const status = typeof input.status === 'string' && (ORDER_STATUSES as readonly string[]).includes(input.status) ? (input.status as OrderStatus) : null;
  try {
    return { ok: true, data: await getContainer().orders.page({ query: input.query, status, cursor: input.cursor }) };
  } catch (error) {
    console.error('[orders] page', error);
    return { ok: false, error: 'The orders could not be loaded. Please try again.' };
  }
}

export async function getOrderAction(id: string): Promise<Order | null> {
  await requirePermission('orders:read');
  return getContainer().orders.getById(id);
}

export async function lookupOrderAction(
  orderNumber: string,
  contact: string,
): Promise<Order | null> {
  return getContainer().orders.findByNumberAndContact(orderNumber, contact);
}

export async function createOrderAction(orderPayload: {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  buyerKraPin?: string | null;
  shippingAddress: {
    street: string;
    city: string;
    countyOrState: string;
    postalCode?: string;
    country: string;
  };
  items: { productId: string; quantity: number }[];
  paymentMethod: PaymentProvider;
  currency?: 'KES' | 'USD';
  dimensionFields?:
    | Record<string, string | null | undefined>
    | {
        global: Record<string, string>;
        shortcut: Record<string, string>;
      };
}): Promise<Order> {
  const order = await OrdersService.createCheckout(orderPayload);
  revalidatePath('/admin/orders');
  revalidatePath('/admin/customers');
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return order;
}

export const createCheckoutOrderAction = createOrderAction;

/** Sends a reopened order back for approval. */
export async function resubmitOrderApprovalAction(
  orderId: string,
): Promise<{ ok: true; status: 'pending' | 'approved' } | { ok: false; error: string }> {
  const userId = await requirePermission('orders:update');
  try {
    const status = await resubmitOrderForApproval(orderId, userId);
    revalidatePath('/admin/orders');
    revalidatePath('/admin/approvals', 'layout');
    return { ok: true, status };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Could not send it for approval.',
    };
  }
}
