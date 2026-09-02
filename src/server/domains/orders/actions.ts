'use server';

import { revalidatePath } from 'next/cache';
import { OrdersService } from './service';
import { AdminService } from '@/server/domains/gateways/service';
import type { Order, PaymentProvider } from '@/types/index';

export async function listOrdersAction(): Promise<Order[]> {
  return AdminService.getAllOrders();
}

export async function getOrderAction(id: string): Promise<Order | null> {
  const orders = AdminService.getAllOrders();
  return orders.find((o) => o.id === id) ?? null;
}

export async function createOrderAction(orderPayload: {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
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
}): Promise<Order> {
  const order = await OrdersService.createCheckout(orderPayload);
  revalidatePath('/admin/orders');
  revalidatePath('/admin/inventory');
  revalidatePath('/');
  return order;
}

export const createCheckoutOrderAction = createOrderAction;
