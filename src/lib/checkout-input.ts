import type { PaymentProvider } from '@/types/index';
import { isRecord } from '@/lib/values';
import { resolvePaymentPhone } from '@/lib/payment-phone';
import { toKenyanMsisdn } from '@/lib/phone';
import { readGeoPoint, type GeoPoint } from '@/lib/geo';
import type { AddressWords } from '@/lib/delivery-zones';

export const PAYMENT_PROVIDERS = ['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni', 'card_direct', 'on_account', 'pay_on_delivery'] as const satisfies readonly PaymentProvider[];

/** How the order is to be delivered: where to (a pin, a written area, or both), who receives it, and the charge the shopper was shown. */
export interface DeliveryInput {
  method: 'own_fleet' | 'courier' | 'pickup';
  /** For collection: the branch the customer chose. The server checks it; it is only a request. */
  pickupBranchId: string | null;
  pin: GeoPoint | null;
  address: AddressWords | null;
  recipient: { name: string; phone: string } | null;
  notes: string | null;
  expectedCharge: number | null;
  /** The delivery time the shopper chose, if the shop offers any. The server checks it against the slot's rules; it is only a request. */
  slot: { slotId: string; day: string } | null;
}

export interface CheckoutInput {
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  /** The mobile number the payment is made from, in 2547XXXXXXXX form, when the customer pays from a line other than their contact number. */
  paymentPhone?: string;
  buyerKraPin?: string;
  shippingAddress: { street: string; city: string; countyOrState: string; country: string };
  items: { productId: string; quantity: number }[];
  paymentMethod: PaymentProvider;
  /** Absent for an order that is not delivered by the shop's own delivery rules. */
  delivery?: DeliveryInput;
}

type DeliveryParsed = { ok: true; value: DeliveryInput | undefined } | { ok: false; error: string };

/** The delivery part of a checkout, or the first thing wrong with it in words for the shopper. */
function parseDelivery(raw: unknown): DeliveryParsed {
  if (raw === undefined || raw === null) return { ok: true, value: undefined };
  if (!isRecord(raw)) return { ok: false, error: 'Your delivery details could not be read.' };
  if (raw.method !== 'own_fleet' && raw.method !== 'courier' && raw.method !== 'pickup') return { ok: false, error: 'Please choose how you want your order delivered.' };
  if (raw.method === 'pickup') {
    // Collecting needs a branch and nothing else about a place: no pin, address, recipient or rider's note.
    const branch = typeof raw.pickupBranchId === 'string' && raw.pickupBranchId.trim() !== '' && raw.pickupBranchId.length <= 100 ? raw.pickupBranchId.trim() : null;
    if (branch === null) return { ok: false, error: 'Choose the branch you will collect from.' };
    const charge = raw.expectedCharge;
    if (charge !== undefined && charge !== null && (typeof charge !== 'number' || !Number.isFinite(charge) || charge < 0 || charge > 1_000_000_000)) return { ok: false, error: 'Your collection details could not be read. Please look at your order again.' };
    return { ok: true, value: { method: 'pickup', pickupBranchId: branch, pin: null, address: null, recipient: null, notes: null, expectedCharge: typeof charge === 'number' ? charge : null, slot: null } };
  }
  let pin: GeoPoint | null = null;
  if (raw.pin !== undefined && raw.pin !== null) {
    const point = isRecord(raw.pin) ? readGeoPoint(raw.pin.latitude, raw.pin.longitude) : null;
    if (point?.ok !== true) return { ok: false, error: 'The pin you dropped is not a place on the map. Please drop it again.' };
    pin = point.point;
  }
  let address: AddressWords | null = null;
  if (isRecord(raw.address)) {
    const part = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim().slice(0, 100) : null);
    const words = { county: part(raw.address.county), town: part(raw.address.town), area: part(raw.address.area) };
    if (words.county !== null || words.town !== null || words.area !== null) address = words;
  }
  if (pin === null && address === null) return { ok: false, error: 'Drop a pin on the map or write your area, so we know where to deliver.' };
  let recipient: DeliveryInput['recipient'] = null;
  if (isRecord(raw.recipient) && (text(raw.recipient.name, 120) ?? '') !== '') {
    const name = text(raw.recipient.name, 120) ?? '';
    const phone = typeof raw.recipient.phone === 'string' ? toKenyanMsisdn(raw.recipient.phone) : null;
    if (phone === null) return { ok: false, error: 'Please enter the mobile number of the person who will receive the order.' };
    recipient = { name, phone };
  }
  const notes = text(raw.notes ?? '', 300);
  if (notes === null) return { ok: false, error: 'The note for the rider is too long.' };
  let slot: DeliveryInput['slot'] = null;
  if (raw.slot !== undefined && raw.slot !== null) {
    const chosen = isRecord(raw.slot) && typeof raw.slot.slotId === 'string' && /^[0-9a-f-]{36}$/i.test(raw.slot.slotId) && typeof raw.slot.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.slot.day) ? { slotId: raw.slot.slotId, day: raw.slot.day } : null;
    if (chosen === null) return { ok: false, error: 'The delivery time you chose could not be read. Please choose it again.' };
    slot = chosen;
  }
  const expected = raw.expectedCharge;
  if (expected !== undefined && expected !== null && (typeof expected !== 'number' || !Number.isFinite(expected) || expected < 0 || expected > 1_000_000_000)) return { ok: false, error: 'Your delivery charge could not be read. Please look at your order again.' };
  return { ok: true, value: { method: raw.method, pickupBranchId: null, pin, address, recipient, notes: notes === '' ? null : notes, expectedCharge: typeof expected === 'number' ? expected : null, slot } };
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
  // An order to be collected has no delivery address: the branch is where it goes, and the server writes that on the order.
  const collecting = isRecord(raw.delivery) && raw.delivery.method === 'pickup';
  if (street === null || county === null || country === null || city === null || (!collecting && (street === '' || city === ''))) {
    return { ok: false, error: 'Please enter your delivery address.' };
  }
  const delivery = parseDelivery(raw.delivery);
  if (!delivery.ok) return { ok: false, error: delivery.error };
  const method = PAYMENT_PROVIDERS.find((provider) => provider === raw.paymentMethod);
  if (method === undefined) return { ok: false, error: 'Please choose how you will pay.' };
  const payFrom = resolvePaymentPhone({ method, contactPhone: phone, paymentPhone: typeof raw.paymentPhone === 'string' && raw.paymentPhone.length <= 40 ? raw.paymentPhone : null });
  if (!payFrom.ok) return { ok: false, error: payFrom.error };
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
      ...(payFrom.phone === null ? {} : { paymentPhone: payFrom.phone }),
      ...(pin === '' ? {} : { buyerKraPin: pin }),
      shippingAddress: { street, city, countyOrState: county, country },
      items,
      paymentMethod: method,
      ...(delivery.value === undefined ? {} : { delivery: delivery.value }),
    },
  };
}
