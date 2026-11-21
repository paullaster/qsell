import { kes } from './tile-style';

/** The sale being rung up, as the till holds it. Pure: every change returns a new cart. Prices shown here are only a guide; the server prices the sale. */

export interface CartLine {
  key: string;
  productId: string;
  name: string;
  quantity: number;
  /** The list price shown before the server has priced the sale (never trusted: the total comes from the server). */
  listPrice: number | null;
  /** A price typed for one unit by someone who may change prices; the server checks it again (floors, their limit) and prices the sale with it. */
  price?: number;
  imageUrl: string;
  package?: { picks: unknown[]; note: string };
}

export type Cart = readonly CartLine[];

export const MAX_LINES = 200;
export const MAX_QUANTITY = 99999;

const clamp = (n: number): number => Math.min(Math.max(Math.round(n * 1000) / 1000, 0.001), MAX_QUANTITY);

/** Adds a product: the same plain product already in the sale gets one more; a package or a new product is a line of its own. */
export function addToCart(cart: Cart, item: Omit<CartLine, 'key' | 'quantity'> & { quantity?: number }, key: string): Cart {
  const quantity = item.quantity ?? 1;
  if (item.package === undefined) {
    const same = cart.find((l) => l.productId === item.productId && l.package === undefined);
    if (same !== undefined) return cart.map((l) => (l.key === same.key ? { ...l, quantity: clamp(l.quantity + quantity) } : l));
  }
  if (cart.length >= MAX_LINES) return cart;
  return [...cart, { ...item, key, quantity: clamp(quantity) }];
}

export function setQuantity(cart: Cart, key: string, quantity: number): Cart {
  if (!Number.isFinite(quantity) || quantity <= 0) return removeLine(cart, key);
  return cart.map((l) => (l.key === key ? { ...l, quantity: clamp(quantity) } : l));
}

/** One more or one fewer; taking the last one off removes the line. */
export function stepLine(cart: Cart, key: string, step: 1 | -1): Cart {
  const line = cart.find((l) => l.key === key);
  if (line === undefined) return cart;
  const next = line.quantity + step;
  return next < 1 && step === -1 ? removeLine(cart, key) : setQuantity(cart, key, next);
}

/** Sets the price of one unit on a line (a price typed at the till), or clears it (null) so the price list decides again. */
export function setPrice(cart: Cart, key: string, price: number | null): Cart {
  return cart.map((l) => {
    if (l.key !== key) return l;
    const { price: _was, ...rest } = l;
    return price === null || !Number.isFinite(price) || price <= 0 ? rest : { ...rest, price: Math.round(price * 100) / 100 };
  });
}

export function removeLine(cart: Cart, key: string): Cart {
  return cart.filter((l) => l.key !== key);
}

/** How many units are in the sale (for the badge on a phone). */
export function unitCount(cart: Cart): number {
  return cart.reduce((n, l) => n + l.quantity, 0);
}

/** What the lines would come to at their list prices, a guide shown until the server has answered. Null when any price is unknown. */
export function guideTotal(cart: Cart): number | null {
  let total = 0;
  for (const l of cart) {
    if (l.listPrice === null) return null;
    total += l.listPrice * l.quantity;
  }
  return Math.round(total * 100) / 100;
}

/** What the total reads as: the server's figure once it has priced the sale, until then a guide from list prices, or a dash for an empty sale. */
export function totalShown(pricedTotal: number | null, cart: Cart): string {
  if (pricedTotal !== null) return kes(pricedTotal);
  if (cart.length === 0) return '—';
  const guide = guideTotal(cart);
  return guide === null ? '…' : kes(guide);
}

/** "KES 50.00 each" for a line, from the server's price when it has one, else the list price, else nothing. */
export function eachShown(serverUnit: number | null, listPrice: number | null): string {
  const unit = serverUnit ?? listPrice;
  return unit === null ? '' : `${kes(unit)} each`;
}
