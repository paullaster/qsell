/** The shopper's cart as the server keeps it, and the reminder about a cart that was left. Pure: the rules and the words. */

export const SERVER_CART_MAX_LINES = 100;
/** A cart is left behind once it has not changed for this long. */
export const REMINDER_IDLE_MINUTES = 180;
/** A cart older than this is not worth a reminder any more. */
export const REMINDER_MAX_AGE_DAYS = 7;
/** A shopper is reminded at most this often, whatever they do to the cart. */
export const REMINDER_GAP_DAYS = 7;

export interface ServerCartLine {
  productId: string;
  quantity: number;
}

/** Keeps only lines that can be right: a product id, a positive quantity, each product once, at most the cap. Anything else is dropped. */
export function cleanCartLines(raw: unknown): ServerCartLine[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const lines: ServerCartLine[] = [];
  for (const entry of raw) {
    if (lines.length >= SERVER_CART_MAX_LINES) break;
    if (typeof entry !== 'object' || entry === null) continue;
    const { productId, quantity } = entry as { productId?: unknown; quantity?: unknown };
    if (typeof productId !== 'string' || productId === '' || productId.length > 100 || seen.has(productId)) continue;
    if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0 || quantity >= 1_000_000) continue;
    seen.add(productId);
    lines.push({ productId, quantity });
  }
  return lines;
}

/**
 * What a shopper has on their account and what they carried in the browser, as one cart. A product in both keeps the larger
 * quantity (not the sum), so joining the same cart twice never doubles it. Account lines keep their place; new ones follow.
 */
export function mergeCartLines(account: readonly ServerCartLine[], browser: readonly ServerCartLine[]): ServerCartLine[] {
  const merged = new Map<string, number>();
  for (const line of cleanCartLines([...account])) merged.set(line.productId, line.quantity);
  for (const line of cleanCartLines([...browser])) merged.set(line.productId, Math.max(merged.get(line.productId) ?? 0, line.quantity));
  return cleanCartLines([...merged].map(([productId, quantity]) => ({ productId, quantity })));
}

export const sameCartLines = (a: readonly ServerCartLine[], b: readonly ServerCartLine[]): boolean => {
  if (a.length !== b.length) return false;
  const left = new Map(a.map((line) => [line.productId, line.quantity]));
  return b.every((line) => left.get(line.productId) === line.quantity);
};

export const isReminderToken = (raw: unknown): raw is string => typeof raw === 'string' && /^[A-Za-z0-9_-]{43}$/.test(raw);

export interface CartReminderFacts {
  tradingName: string;
  customerName: string;
  /** What is in the cart, named, in the cart's order. */
  items: { name: string; quantity: string }[];
  cartUrl: string;
  stopUrl: string;
}

export interface CartReminderContent {
  subject: string;
  heading: string;
  greeting: string;
  body: string;
  cta: string;
  details: [string, string][];
  footer: string;
}

const SHOWN = 6;
const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? '';

export function cartReminderContent(f: CartReminderFacts): CartReminderContent {
  const shown = f.items.slice(0, SHOWN);
  const more = f.items.length - shown.length;
  const details: [string, string][] = shown.map((item) => [item.name, `× ${item.quantity}`]);
  if (more > 0) details.push([`and ${more} more`, '']);
  return {
    subject: `You left something in your cart at ${f.tradingName}`,
    heading: 'Your cart is waiting',
    greeting: firstName(f.customerName) === '' ? 'Hello,' : `Hello ${firstName(f.customerName)},`,
    body: `You left ${f.items.length === 1 ? 'an item' : 'some items'} in your cart at ${f.tradingName}. Nothing is held for you until you check out, so stock and prices may change. Prices are shown again when you open your cart.`,
    cta: 'Return to your cart',
    details,
    footer: `We send at most one of these a week, and only when a cart is left. To stop them: ${f.stopUrl}`,
  };
}
