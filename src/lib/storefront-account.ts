import type { Order, OrderStatus, PaymentStatus } from '@/types/index';
import { has } from '@/lib/values';

/**
 * Pure rules for a shopper's own account screens: which order is theirs, what of an order they may
 * see, how its state reads in plain words, and what makes an address book entry valid. The server
 * applies these; the browser uses the same checks only for convenience.
 */

/** An order as the shopper sees it: nothing internal (notes, costs, price traces, dimensions, KRA state). */
export interface CustomerOrder {
  id: string;
  orderNumber: string;
  status: OrderStatus;
  paymentStatus: PaymentStatus;
  currency: string;
  createdAt: string;
  subtotal: number;
  tax: number;
  shippingFee: number;
  totalAmount: number;
  shippingAddress: Order['shippingAddress'];
  shippingCourier: string | null;
  trackingNumber: string | null;
  shippedAt: string | null;
  deliveredAt: string | null;
  items: {
    productName: string;
    sku: string;
    quantity: number;
    unitPrice: number;
    totalPrice: number;
    imageUrl: string;
    isGift: boolean;
  }[];
}

export function toCustomerOrder(order: Order): CustomerOrder {
  return {
    id: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    paymentStatus: order.paymentStatus,
    currency: order.currency,
    createdAt: order.createdAt,
    subtotal: order.subtotal,
    tax: order.tax,
    shippingFee: order.shippingFee,
    totalAmount: order.totalAmount,
    shippingAddress: order.shippingAddress,
    shippingCourier: order.shippingCourier ?? null,
    trackingNumber: order.trackingNumber ?? null,
    shippedAt: order.shippedAt ?? null,
    deliveredAt: order.deliveredAt ?? null,
    items: order.items.map((item) => ({
      productName: item.productName,
      sku: item.sku,
      quantity: item.quantity,
      unitPrice: item.unitPrice,
      totalPrice: item.totalPrice,
      imageUrl: item.imageUrl,
      isGift: item.isGift === true,
    })),
  };
}

/** The identities an order may carry for one shopper: store account id, login id, email and trade customer. */
export interface OrderOwner {
  ids: readonly string[];
  email: string;
  tradeCustomerId: string | null;
}

/** True when the order belongs to the shopper. Orders without any owner mark belong to nobody. */
export function ownsOrder(
  order: Pick<Order, 'userId' | 'tradeCustomerId'>,
  owner: OrderOwner,
): boolean {
  const userId = order.userId.toLowerCase();
  if (has(userId) && (owner.ids.includes(order.userId) || userId === owner.email.toLowerCase()))
    return true;
  return owner.tradeCustomerId !== null && order.tradeCustomerId === owner.tradeCustomerId;
}

type Tone = 'green' | 'amber' | 'red' | 'sky' | 'gray';

const ORDER_STATE: Record<OrderStatus, { label: string; tone: Tone; hint: string }> = {
  pending: {
    label: 'Received',
    tone: 'amber',
    hint: 'We have your order and will start preparing it soon.',
  },
  processing: {
    label: 'Being prepared',
    tone: 'sky',
    hint: 'Your items are being picked and packed.',
  },
  shipped: {
    label: 'On its way',
    tone: 'sky',
    hint: 'Your order has left us and is being delivered.',
  },
  delivered: { label: 'Delivered', tone: 'green', hint: 'Your order has arrived.' },
  completed: { label: 'Completed', tone: 'green', hint: 'This order is complete.' },
  failed: {
    label: 'Not completed',
    tone: 'red',
    hint: 'This order could not be completed. Contact us if you were charged.',
  },
  cancelled: { label: 'Cancelled', tone: 'gray', hint: 'This order was cancelled.' },
  refunded: { label: 'Refunded', tone: 'gray', hint: 'This order was refunded.' },
};

export const orderStateOf = (status: string): { label: string; tone: Tone; hint: string } =>
  (ORDER_STATE as Record<string, { label: string; tone: Tone; hint: string }>)[status] ?? {
    label: status,
    tone: 'gray',
    hint: '',
  };

const PAYMENT_STATE: Record<PaymentStatus, { label: string; tone: Tone }> = {
  unpaid: { label: 'Awaiting payment', tone: 'amber' },
  pending_verification: { label: 'Payment being confirmed', tone: 'amber' },
  partially_paid: { label: 'Part paid', tone: 'amber' },
  paid: { label: 'Paid', tone: 'green' },
  reconciled: { label: 'Paid', tone: 'green' },
  discrepancy: { label: 'Payment being checked', tone: 'amber' },
  failed: { label: 'Payment failed', tone: 'red' },
};

export const paymentStateOf = (status: string): { label: string; tone: Tone } =>
  (PAYMENT_STATE as Record<string, { label: string; tone: Tone }>)[status] ?? {
    label: status,
    tone: 'gray',
  };

/** What an address form holds, as text. */
export interface AddressFields {
  label: string;
  recipientName: string;
  recipientPhone: string;
  street: string;
  city: string;
  countyOrState: string;
  postalCode: string;
  country: string;
  /** The place on the map for this address (both or neither); the browser reads it from the device, the server checks it. */
  latitude: number | null;
  longitude: number | null;
  isDefault: boolean;
}

export const blankAddress: AddressFields = {
  label: '',
  recipientName: '',
  recipientPhone: '',
  street: '',
  city: '',
  countyOrState: '',
  postalCode: '',
  country: 'Kenya',
  latitude: null,
  longitude: null,
  isDefault: false,
};

const REQUIRED: [keyof AddressFields, string, number][] = [
  ['label', 'Name this address (for example Home or Office)', 60],
  ['recipientName', 'Who receives the delivery', 120],
  ['recipientPhone', 'A phone number for the delivery', 30],
  ['street', 'Street or building', 200],
  ['city', 'Town or city', 100],
  ['countyOrState', 'County or state', 100],
  ['country', 'Country', 100],
];

/** The place on the map sent with an address: both numbers on the earth, or neither. Anything else is refused in words. */
function readPlace(latitude: unknown, longitude: unknown): { ok: true; latitude: number | null; longitude: number | null } | { ok: false; error: string } {
  const empty = (v: unknown): boolean => v === null || v === undefined;
  if (empty(latitude) && empty(longitude)) return { ok: true, latitude: null, longitude: null };
  const good = typeof latitude === 'number' && typeof longitude === 'number' && Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
  if (!good) return { ok: false, error: 'The place on the map is not valid. Use your location again, or remove it.' };
  return { ok: true, latitude: Math.round(latitude * 1e6) / 1e6, longitude: Math.round(longitude * 1e6) / 1e6 };
}

/** The address cleaned up, or the first thing wrong with it in plain words. Never trusts the browser. */
export function readAddress(
  raw: unknown,
): { ok: true; address: AddressFields } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null)
    return { ok: false, error: 'The address is not valid.' };
  const source = raw as Record<string, unknown>;
  const text = (key: string): string => {
    const value = source[key];
    return typeof value === 'string' ? value.trim() : '';
  };
  for (const [key, message, max] of REQUIRED) {
    if (!has(text(key))) return { ok: false, error: `${message}.` };
    if (text(key).length > max)
      return { ok: false, error: `${message} is too long (${String(max)} characters at most).` };
  }
  if (!/^[+\d][\d\s()-]{6,}$/.test(text('recipientPhone'))) {
    return { ok: false, error: 'Enter a phone number with digits only, for example 0712 345 678.' };
  }
  if (text('postalCode').length > 20) return { ok: false, error: 'The postal code is too long.' };
  const place = readPlace(source.latitude, source.longitude);
  if (!place.ok) return { ok: false, error: place.error };
  return {
    ok: true,
    address: {
      label: text('label'),
      recipientName: text('recipientName'),
      recipientPhone: text('recipientPhone'),
      street: text('street'),
      city: text('city'),
      countyOrState: text('countyOrState'),
      postalCode: text('postalCode'),
      country: text('country'),
      latitude: place.latitude,
      longitude: place.longitude,
      isDefault: source.isDefault === true,
    },
  };
}

/** "KES 1,234.50"; fixed grouping so the server and the browser print the same text. */
export function formatAmount(value: number, currency: string): string {
  const [whole = '0', cents = '00'] = Math.abs(value).toFixed(2).split('.');
  return `${value < 0 ? '-' : ''}${currency} ${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${cents}`;
}

/** "24 Oct 2026" in the business's time zone, so a late-evening order is not dated the next day somewhere else. */
export function formatOrderDate(iso: string, timeZone: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone });
}

/** "3 items" / "1 item": the number of units across the order's lines. */
export function itemCountLabel(order: Pick<CustomerOrder, 'items'>): string {
  const units = order.items.reduce((sum, item) => sum + item.quantity, 0);
  return `${String(units)} ${units === 1 ? 'item' : 'items'}`;
}
