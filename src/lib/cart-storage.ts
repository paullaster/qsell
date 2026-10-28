import { isRecord } from '@/lib/values';

/** Where the cart is kept in the browser. Version 2 holds ids and quantities only; prices and stock are read fresh. */
export const CART_STORAGE_KEY = 'qsell_cart_v2';
/** The key the first shop used, which kept a whole copy of each product. Read once, then dropped. */
export const LEGACY_CART_STORAGE_KEY = 'omnicommerce_cart';

/** A cart line as saved: which product, how many, and the price the shopper last saw (to tell them if it moved). */
export interface SavedCartLine {
  productId: string;
  quantity: number;
  price: number | null;
}

/** Product identifiers and requested quantities shared by the business website when opening checkout. */
export function parseCartHandoff(raw: unknown): SavedCartLine[] {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 16_000) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const lines: SavedCartLine[] = [];
    for (const entry of value.slice(0, 100)) {
      if (!isRecord(entry)) continue;
      const id = entry.id;
      const quantity = entry.quantity;
      if (typeof id !== 'string' || id === '' || id.length > 100 || seen.has(id)) continue;
      if (
        typeof quantity !== 'number' ||
        !Number.isFinite(quantity) ||
        quantity <= 0 ||
        quantity >= 1_000_000
      )
        continue;
      seen.add(id);
      lines.push({ productId: id, quantity, price: null });
    }
    return lines;
  } catch {
    return [];
  }
}

const MAX_LINES = 100;

function lineOf(value: unknown): SavedCartLine | null {
  if (!isRecord(value)) return null;
  // The first shop's lines carried the product itself: { product: { id, price }, quantity }.
  const product = isRecord(value.product) ? value.product : null;
  const id = value.productId ?? product?.id;
  const price = value.price ?? product?.price;
  const quantity = value.quantity;
  if (typeof id !== 'string' || id === '' || id.length > 100) return null;
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) return null;
  return {
    productId: id,
    quantity,
    price: typeof price === 'number' && Number.isFinite(price) ? price : null,
  };
}

/** The saved cart, however old its shape; anything unreadable is dropped and a damaged value gives an empty cart. */
export function parseSavedCart(raw: string | null | undefined): SavedCartLine[] {
  if (raw === null || raw === undefined || raw === '') return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const lines: SavedCartLine[] = [];
    for (const entry of value.slice(0, MAX_LINES)) {
      const line = lineOf(entry);
      if (line === null || seen.has(line.productId)) continue;
      seen.add(line.productId);
      lines.push(line);
    }
    return lines;
  } catch {
    return [];
  }
}

export function serializeCart(lines: readonly SavedCartLine[]): string {
  return JSON.stringify(
    lines.map(({ productId, quantity, price }) => ({ productId, quantity, price })),
  );
}
