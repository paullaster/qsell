import { isRecord } from '@/lib/values';

/** What the browser says it wants to buy: ids and counts only. A package line also carries the choices made (`quantity` is its servings). */
export interface BasketItem {
  productId: string;
  quantity: number;
  package?: { picks: { slotId: string; optionId: string; count: number }[]; /** What the customer wrote on the serving. */ note?: string };
}

const MAX_PICKS = 1000;

/** Reads one basket line from the browser, or null when it cannot be read. Nothing about price or stock is taken. */
export function readBasketItem(raw: unknown, maxQuantity = 1_000_000): BasketItem | null {
  if (!isRecord(raw) || typeof raw.productId !== 'string' || raw.productId === '' || raw.productId.length > 100) return null;
  if (typeof raw.quantity !== 'number' || !Number.isFinite(raw.quantity) || raw.quantity <= 0 || raw.quantity > maxQuantity) return null;
  if (raw.package === undefined || raw.package === null) return { productId: raw.productId, quantity: raw.quantity };
  if (!isRecord(raw.package) || !Array.isArray(raw.package.picks) || !Number.isInteger(raw.quantity)) return null;
  const picks: NonNullable<BasketItem['package']>['picks'] = [];
  for (const pick of raw.package.picks.slice(0, MAX_PICKS)) {
    if (!isRecord(pick) || typeof pick.slotId !== 'string' || typeof pick.optionId !== 'string' || typeof pick.count !== 'number' || !Number.isFinite(pick.count)) return null;
    if (pick.slotId.length === 0 || pick.slotId.length > 100 || pick.optionId.length === 0 || pick.optionId.length > 100) return null;
    picks.push({ slotId: pick.slotId, optionId: pick.optionId, count: pick.count });
  }
  const note = typeof raw.package.note === 'string' && raw.package.note.trim() !== '' ? raw.package.note.slice(0, 201) : undefined;
  return { productId: raw.productId, quantity: raw.quantity, package: { picks, ...(note === undefined ? {} : { note }) } };
}

/** Reads a list of basket lines: at most `max`, and null when any line cannot be read. */
export function readBasketItems(raw: unknown, max = 100, maxQuantity = 1_000_000): BasketItem[] | null {
  if (!Array.isArray(raw)) return null;
  const items = raw.slice(0, max).map((entry) => readBasketItem(entry, maxQuantity));
  return items.every((item) => item !== null) && items.length === Math.min(raw.length, max) ? (items) : null;
}
