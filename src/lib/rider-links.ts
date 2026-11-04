import { dialable } from './delivery-rider';
import type { GeoPoint } from './geo';

/** A link that dials the number, or null when it is not a number. */
export function callLink(phone: string | null | undefined): string | null {
  const number = dialable(phone);
  return number === null ? null : `tel:${number}`;
}

/** A WhatsApp chat with the number (international digits only, as WhatsApp wants them), or null. A local 07… number is read as Kenyan. */
export function chatLink(phone: string | null | undefined): string | null {
  const number = dialable(phone);
  if (number === null) return null;
  const digits = number.replace(/\D/g, '');
  const local = !number.startsWith('+') && digits.startsWith('0');
  return `https://wa.me/${local ? `254${digits.slice(1)}` : digits}`;
}

/** Opens the phone's own map app at the pin, or at the written address when there is no pin; null when there is neither. */
export function navigateLink(pin: GeoPoint | null, address: readonly string[]): string | null {
  if (pin !== null) return `geo:${String(pin.latitude)},${String(pin.longitude)}?q=${String(pin.latitude)},${String(pin.longitude)}`;
  const written = address.map((p) => p.trim()).filter((p) => p !== '').join(', ');
  return written === '' ? null : `geo:0,0?q=${encodeURIComponent(written)}`;
}
