import { roundQty } from '@/lib/decimal';
import type { QuantityLimits } from '@/lib/quantity-limits';

/**
 * Quantities in the storefront cart. Goods counted whole (pieces) move by 1; goods sold by weight, length or
 * volume move by half a unit and can also be typed exactly (0.25 kg), within what the unit allows. Pure.
 */

/** Decimals the product's unit allows; a cart saved before units existed has none, so its goods are whole. */
export const decimalsOf = (product: { baseUnitDecimals?: number }): number =>
  Math.min(3, Math.max(0, product.baseUnitDecimals ?? 0));

/** What the + and - buttons add and take away. */
export const cartStep = (decimals: number): number => (decimals <= 0 ? 1 : 0.5);

/** The least that can be bought: one piece, or the finest amount the unit counts (0.001 kg). */
export const minCartQuantity = (decimals: number): number =>
  decimals <= 0 ? 1 : 10 ** -Math.min(3, decimals);

/** What can still be sold: the stock not already reserved for someone else. */
export const availableOf = (product: { stockQuantity: number; reservedQuantity: number }): number =>
  Math.max(0, roundQty(product.stockQuantity - product.reservedQuantity));

/**
 * A wanted quantity made into one that can be bought: rounded to the unit's decimals, at least the least
 * that can be bought, and at most what is available. 0 when not even the least is available.
 */
export function clampCartQuantity(wanted: number, decimals: number, available: number, limits?: QuantityLimits): number {
  const scale = 10 ** Math.min(3, Math.max(0, decimals));
  // The item's own limits narrow the range: never less than its minimum, never more than its maximum.
  const most = Math.min(Math.floor(available * scale + 1e-9) / scale, limits?.maxQty ?? Number.POSITIVE_INFINITY);
  const least = Math.max(minCartQuantity(decimals), limits?.minQty ?? 0);
  if (most < least) return 0;
  if (!Number.isFinite(wanted)) return least;
  return Math.min(most, Math.max(least, Math.round(wanted * scale + 1e-9) / scale));
}

/** The quantity one press of + (direction 1) or - (direction -1) leads to. */
export function stepCartQuantity(
  current: number,
  direction: 1 | -1,
  decimals: number,
  available: number,
  limits?: QuantityLimits,
): number {
  return clampCartQuantity(roundQty(current + direction * cartStep(decimals)), decimals, available, limits);
}

/** What the person typed, as a quantity; null when it is not a number above zero. */
export function parseCartQuantity(text: string): number | null {
  const n = Number(text.trim().replace(',', '.'));
  return text.trim() !== '' && Number.isFinite(n) && n > 0 ? n : null;
}

/** "2.5 kg", or just "3" for a piece. */
export function cartQuantityWords(
  quantity: number,
  product: { baseUnitCode?: string; baseUnitDecimals?: number },
): string {
  const shown = String(roundQty(quantity));
  const code = product.baseUnitCode ?? '';
  return decimalsOf(product) > 0 && code !== '' ? `${shown} ${code}` : shown;
}

/** " / kg" after a price when the goods are sold by a unit that is worth saying; nothing for pieces. */
export function perUnitSuffix(product: {
  baseUnitCode?: string;
  baseUnitDecimals?: number;
}): string {
  const code = product.baseUnitCode ?? '';
  return decimalsOf(product) > 0 && code !== '' ? ` / ${code}` : '';
}

/** The number on the cart badge: whole goods count by piece, goods sold by weight count once per line. */
export function cartBadgeCount(
  items: readonly { quantity: number; product: { baseUnitDecimals?: number } }[],
): number {
  return items.reduce((n, i) => n + (decimalsOf(i.product) > 0 ? 1 : i.quantity), 0);
}
