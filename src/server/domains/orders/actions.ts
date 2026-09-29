'use server';

import { requirePermission } from '@/server/domains/access-control/guard';

import { revalidatePath } from 'next/cache';
import { OrdersService } from './service';
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
  dimensionFields?: Record<string, string | null | undefined> | {
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
