import type { Order, OrderStatus } from '@/types/index';

/** The admin Orders screen: the states, their words, and small rules about an order. Pure. */

export const ORDER_STATUSES = [
  'pending',
  'processing',
  'shipped',
  'delivered',
  'completed',
  'failed',
  'cancelled',
  'refunded',
] as const satisfies readonly OrderStatus[];

export interface StatusChoice {
  id: string;
  label: string;
}

/** What the list can be narrowed to. "Delivered" also shows completed orders, which read the same to a person. */
export const STATUS_FILTERS: readonly StatusChoice[] = [
  { id: 'pending', label: 'Pending payment' },
  { id: 'processing', label: 'Processing / paid' },
  { id: 'shipped', label: 'In transit / shipped' },
  { id: 'delivered', label: 'Delivered' },
  { id: 'completed', label: 'Completed' },
  { id: 'cancelled', label: 'Cancelled' },
  { id: 'failed', label: 'Failed' },
  { id: 'refunded', label: 'Refunded' },
];

/** How long an order to be collected may have waited at the counter, to narrow the orders list by. */
export const COUNTER_WAIT_FILTERS: readonly { id: string; label: string; days: number }[] = [
  { id: '1', label: 'At the counter 1 day or more', days: 1 },
  { id: '3', label: 'At the counter 3 days or more', days: 3 },
  { id: '7', label: 'At the counter 7 days or more', days: 7 },
];

/** The days a counter-wait choice stands for, or null when it is not one of the choices (so a made-up value narrows nothing). */
export function counterWaitDays(id: string | null | undefined): number | null {
  return COUNTER_WAIT_FILTERS.find((f) => f.id === id)?.days ?? null;
}

/** The states a person can move an order to by hand. */
export const FULFILMENT_STATUSES: readonly StatusChoice[] = [
  { id: 'pending', label: 'Pending payment' },
  { id: 'processing', label: 'Processing / order confirmed' },
  { id: 'shipped', label: 'Dispatched / in transit' },
  { id: 'delivered', label: 'Delivered to customer' },
  { id: 'cancelled', label: 'Cancelled (restock)' },
];

export const statusChoice = (list: readonly StatusChoice[], id: string): StatusChoice =>
  list.find((s) => s.id === id) ?? { id, label: id };

/** An order is held until it is approved when approval is pending, was refused, or is still a draft. */
export const heldForApproval = (order: Pick<Order, 'approvalStatus'>): boolean =>
  ['pending', 'rejected', 'draft'].includes(order.approvalStatus ?? 'none');

export const isOrderPaid = (order: Pick<Order, 'paymentStatus'>): boolean =>
  order.paymentStatus === 'paid' || order.paymentStatus === 'reconciled';

export function money(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString('en-KE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** How many units an order holds in all (goods sold by weight count by the unit they were sold in). */
export const unitsIn = (order: Pick<Order, 'items'>): number =>
  Math.round(order.items.reduce((n, i) => n + i.quantity, 0) * 1000) / 1000;

/** The words of the one-line address on a delivery. */
export function addressLine(address: Order['shippingAddress'] | null | undefined): string {
  if (address === null || address === undefined) return 'No shipping address on file';
  return [address.street, address.city, address.countyOrState, address.country].join(', ');
}
