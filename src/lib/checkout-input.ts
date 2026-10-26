import type { PaymentProvider } from '@/types/index';
import { isRecord } from '@/lib/values';

export const PAYMENT_PROVIDERS = ['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni', 'card_direct', 'on_account'] as const satisfies readonly PaymentProvider[];

export interface CheckoutInput {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  buyerKraPin?: string;
  shippingAddress: { street: string; city: string; countyOrState: string; country: string };
  items: { productId: string; quantity: number }[];
  paymentMethod: PaymentProvider;
}

type Parsed = { ok: true; value: CheckoutInput } | { ok: false; error: string };

const MAX_ITEMS = 100;

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.length <= max ? value.trim() : null;
}

/**
 * Reads what the browser sent for a checkout into the shape the shop works with. This is the first of the server's
 * checks, not the only one: prices, stock, the customer and the payment method are all decided from the server's own data.
 */
export function parseCheckoutInput(raw: unknown): Parsed {
  if (!isRecord(raw)) return { ok: false, error: 'Your order could not be read. Please try again.' };
  const name = text(raw.customerName, 120);
  const email = text(raw.customerEmail ?? '', 254);
  const phone = text(raw.customerPhone, 40);
  const pin = raw.buyerKraPin === undefined || raw.buyerKraPin === null ? '' : text(raw.buyerKraPin, 20);
  const address = isRecord(raw.shippingAddress) ? raw.shippingAddress : null;
  const street = text(address?.street, 200);
  const city = text(address?.city, 100);
  const county = text(address?.countyOrState ?? '', 100);
  const country = text(address?.country ?? '', 100);
  if (name === null || name === '') return { ok: false, error: 'Please enter your name.' };
  if (phone === null || phone === '') return { ok: false, error: 'Please enter your mobile phone number.' };
  if (email === null) return { ok: false, error: 'That email address is too long.' };
  if (pin === null) return { ok: false, error: 'That tax PIN is too long.' };
  if (street === null || street === '' || city === null || city === '' || county === null || country === null) {
    return { ok: false, error: 'Please enter your delivery address.' };
  }
  const method = PAYMENT_PROVIDERS.find((provider) => provider === raw.paymentMethod);
  if (method === undefined) return { ok: false, error: 'Please choose how you will pay.' };
  if (!Array.isArray(raw.items) || raw.items.length === 0) return { ok: false, error: 'Your cart is empty.' };
  if (raw.items.length > MAX_ITEMS) return { ok: false, error: 'There are too many different items in your cart.' };
  const items: CheckoutInput['items'] = [];
  for (const item of raw.items) {
    if (!isRecord(item) || typeof item.productId !== 'string' || item.productId === '' || item.productId.length > 100) {
      return { ok: false, error: 'Something in your cart could not be read. Please remove it and add it again.' };
    }
    if (typeof item.quantity !== 'number' || !Number.isFinite(item.quantity) || item.quantity <= 0 || item.quantity > 1_000_000) {
      return { ok: false, error: 'One of the quantities in your cart is not valid.' };
    }
    // The same product twice is one line.
    const same = items.find((line) => line.productId === item.productId);
    if (same === undefined) items.push({ productId: item.productId, quantity: item.quantity });
    else same.quantity += item.quantity;
  }
  return {
    ok: true,
    value: {
      customerName: name,
      customerEmail: email,
      customerPhone: phone,
      ...(pin === '' ? {} : { buyerKraPin: pin }),
      shippingAddress: { street, city, countyOrState: county, country },
      items,
      paymentMethod: method,
    },
  };
}
