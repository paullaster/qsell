/**
 * Ways for the rep to reach and find a customer from the phone: call, WhatsApp, and directions. Pure: the links are built here and opened by the phone.
 */
import { normalizePhone } from '@/lib/rider-pin';

export interface Pin {
  lat: number;
  lng: number;
}

/** A link that rings the customer, or null when there is no Kenyan mobile number on the card. */
export function callLink(phone: string | null): string | null {
  const n = normalizePhone(phone);
  return n === null ? null : `tel:+${n}`;
}

/** A link that opens a WhatsApp chat with the customer, with a first line when there is one. */
export function whatsappLink(phone: string | null, text = ''): string | null {
  const n = normalizePhone(phone);
  if (n === null) return null;
  const line = text.trim();
  return `https://wa.me/${n}${line === '' ? '' : `?text=${encodeURIComponent(line)}`}`;
}

const validPin = (pin: Pin | null): pin is Pin => pin !== null && Number.isFinite(pin.lat) && Number.isFinite(pin.lng) && Math.abs(pin.lat) <= 90 && Math.abs(pin.lng) <= 180;

/** Directions to the customer: to the map pin where there is one, otherwise to the place written on the card; null when neither is known. */
export function directionsLink(pin: Pin | null, place: string | null): string | null {
  if (validPin(pin)) return `https://www.google.com/maps/dir/?api=1&destination=${String(pin.lat)},${String(pin.lng)}`;
  const words = (place ?? '').trim();
  return words === '' ? null : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(words)}`;
}
