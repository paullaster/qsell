import type { LineDiscount } from '@/lib/till/cart';

/** One line of a sales order, credit sale or sales invoice as the screen holds it. Prices here are for showing; the server prices the document. */
export interface DocLine {
  key: string;
  productId: string;
  name: string;
  /** What was typed in the quantity box. */
  quantity: string;
  /** The list price now, for showing beside what is charged. */
  listPrice: number | null;
  /** A price typed for one unit by someone who may change prices. */
  price?: number;
  /** A discount typed by someone who may give one. */
  discount?: LineDiscount;
  package?: { picks: unknown[]; note: string; summary: string };
}

export interface PricedLine {
  productId: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
}

export interface Priced {
  subtotal: number;
  tax: number;
  total: number;
  lines: PricedLine[];
}

const cents = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

/** The quantity typed, or 0 when it is not a number above nothing. */
export function quantityOf(line: Pick<DocLine, 'quantity'>): number {
  const n = Number(line.quantity);
  return line.quantity.trim() !== '' && Number.isFinite(n) && n > 0 ? n : 0;
}

/** The line as it is sent: ids, counts, and the typed price or discount. Everything else is the server's to decide. */
export function payloadLine(line: DocLine) {
  return {
    productId: line.productId,
    quantity: quantityOf(line),
    ...(line.package === undefined ? {} : { package: { picks: line.package.picks, note: line.package.note } }),
    ...(line.package === undefined && line.price !== undefined ? { unitPrice: line.price } : {}),
    ...(line.package === undefined && line.discount !== undefined ? { discount: line.discount } : {}),
  };
}

/** Each line's priced answer, by its place (the server keeps the order), else by the same product and quantity not yet used. */
export function pricedFor(priced: Priced | null, lines: readonly DocLine[]): (PricedLine | null)[] {
  if (priced === null) return lines.map(() => null);
  const used = new Set<number>();
  return lines.map((line, at) => {
    const q = quantityOf(line);
    const same = (p: PricedLine | undefined) => p?.productId === line.productId && Math.abs(p.quantity - q) < 1e-9;
    let hit = same(priced.lines[at]) && !used.has(at) ? at : -1;
    if (hit < 0) hit = priced.lines.findIndex((p, n) => !used.has(n) && same(p));
    if (hit < 0) return null;
    used.add(hit);
    return priced.lines[hit] ?? null;
  });
}

export interface LineShown {
  /** What one unit is charged, when known. */
  unit: number | null;
  /** What the line comes to, when known. */
  total: number | null;
  /** The price before a typed price or discount, to show beside the charged one. */
  was: number | null;
  changed: 'price' | 'discount' | null;
}

function changeOf(line: DocLine): LineShown['changed'] {
  if (line.discount !== undefined) return 'discount';
  return line.price === undefined ? null : 'price';
}

/** What to show for a line: the server's price when it has priced it, else the list price. */
export function lineShown(line: DocLine, priced: PricedLine | null): LineShown {
  const q = quantityOf(line);
  const unit = priced?.unitPrice ?? line.price ?? line.listPrice;
  const total = priced?.lineTotal ?? (unit === null || q === 0 ? null : cents(unit * q));
  const changed = changeOf(line);
  // A discount comes off the typed price when there is one, else off the list price; a typed price is compared with the list price.
  const before = changed === 'discount' ? (line.price ?? line.listPrice) : line.listPrice;
  const was = changed !== null && before !== null && unit !== null && Math.abs(before - unit) >= 0.005 ? before : null;
  return { unit, total, was, changed };
}

/** The guide total at list prices, before the server has priced the document. Null when no line has a list price. */
export function listEstimate(lines: readonly DocLine[]): number | null {
  const counted = lines.filter((l) => l.package === undefined && l.listPrice !== null);
  return counted.length === 0 ? null : cents(counted.reduce((sum, l) => sum + (l.listPrice ?? 0) * quantityOf(l), 0));
}

/** Whether the document can be placed from what is on the screen. */
export function readyToPlace(hasCustomer: boolean, lines: readonly DocLine[]): boolean {
  return hasCustomer && lines.length > 0 && lines.every((l) => quantityOf(l) > 0);
}

/** A price typed in the unit price box: a number above nothing to the cent, else null. */
export function readTypedPrice(text: string): number | null {
  const n = Number(text.trim());
  return text.trim() !== '' && Number.isFinite(n) && n > 0 && n <= 100_000_000 ? cents(n) : null;
}
