import type { PublicProduct } from '@/types/index';
import { availableOf, cartQuantityWords, clampCartQuantity, decimalsOf } from '@/lib/cart-quantity';
import { roundQty } from '@/lib/decimal';
import type { SavedCartLine } from '@/lib/cart-storage';

export interface CartLine {
  product: PublicProduct;
  quantity: number;
}

/** Something the shopper should be told about their cart, in plain words. */
export interface CartNotice {
  productId: string;
  kind: 'removed' | 'reduced' | 'price';
  message: string;
}

export const savedLines = (lines: readonly CartLine[]): SavedCartLine[] =>
  lines.map(({ product, quantity }) => ({ productId: product.id, quantity, price: product.price ?? null }));

export type AddOutcome = 'added' | 'capped' | 'sold_out';

/** Adds a product to a cart: more of what is there, up to what is in stock. Pure. */
export function addToCart(
  lines: readonly CartLine[],
  product: PublicProduct,
  quantity: number,
): { lines: CartLine[]; outcome: AddOutcome; quantity: number } {
  const decimals = decimalsOf(product);
  const available = availableOf(product);
  const existing = lines.find((line) => line.product.id === product.id);
  const wanted = roundQty((existing?.quantity ?? 0) + quantity);
  const next = clampCartQuantity(wanted, decimals, available);
  if (next === 0) return { lines: [...lines], outcome: 'sold_out', quantity: existing?.quantity ?? 0 };
  const outcome: AddOutcome = next < wanted ? 'capped' : 'added';
  if (existing === undefined) return { lines: [...lines, { product, quantity: next }], outcome, quantity: next };
  return { lines: lines.map((line) => (line.product.id === product.id ? { product, quantity: next } : line)), outcome, quantity: next };
}

/** Sets a line's quantity within what can be bought; nothing or less removes it. */
export function setCartQuantity(lines: readonly CartLine[], productId: string, quantity: number): CartLine[] {
  return lines.flatMap((line) => {
    if (line.product.id !== productId) return [line];
    if (!(quantity > 0)) return [];
    const next = clampCartQuantity(quantity, decimalsOf(line.product), availableOf(line.product));
    return next === 0 ? [] : [{ product: line.product, quantity: next }];
  });
}

/**
 * Brings a saved cart up to date with what the shop sells now: current prices and stock, products that are gone
 * dropped, quantities cut to what is left. Says what changed so nothing moves without the shopper knowing.
 */
export function reconcileCart(saved: readonly SavedCartLine[], fresh: readonly PublicProduct[], money: (amount: number) => string): { lines: CartLine[]; notices: CartNotice[] } {
  const byId = new Map(fresh.map((product) => [product.id, product]));
  const lines: CartLine[] = [];
  const notices: CartNotice[] = [];
  for (const line of saved) {
    const product = byId.get(line.productId);
    if (product === undefined) {
      notices.push({ productId: line.productId, kind: 'removed', message: 'An item in your cart is no longer for sale and was removed.' });
      continue;
    }
    const quantity = clampCartQuantity(line.quantity, decimalsOf(product), availableOf(product));
    if (quantity === 0) {
      notices.push({ productId: product.id, kind: 'removed', message: `${product.name} is sold out and was removed from your cart.` });
      continue;
    }
    if (quantity < line.quantity) {
      notices.push({ productId: product.id, kind: 'reduced', message: `Only ${cartQuantityWords(quantity, product)} of ${product.name} ${quantity === 1 ? 'is' : 'are'} left, so the quantity was reduced.` });
    }
    const price = product.price ?? null;
    if (line.price !== null && price !== null && line.price !== price) {
      notices.push({ productId: product.id, kind: 'price', message: `The price of ${product.name} changed from ${money(line.price)} to ${money(price)}.` });
    }
    lines.push({ product, quantity });
  }
  return { lines, notices };
}
