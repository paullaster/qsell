'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { OrdersService } from './service';
import { resubmitOrderForApproval } from './approval';
import { getContainer } from '@/server/di/container';
import type { Order, PaymentProvider } from '@/types/index';

export async function listOrdersAction(): Promise<Order[]> {
  await requirePermission('orders:read');
  return getContainer().orders.listAll();
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
