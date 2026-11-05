import type { CatalogueProduct } from '@/lib/catalogue-entry';

/** The parts of a quote line the refresh reads and may change. */
export interface RefreshableLine {
  productId: string;
  unitPrice?: number | null;
  priceMode?: string;
}

export interface RefreshNote {
  productId: string;
  /** Zero-based position of the line. */
  line: number;
  message: string;
}

/**
 * Brings the open (draft) quote's lines up to date after their product was changed in the edit window.
 *
 * - A line on catalogue pricing follows the product's price: that is what catalogue pricing means, and the price lists' answer replaces it.
 * - A line whose price was typed or negotiated keeps it. Nothing the person set is changed silently; a note says the catalogue moved.
 * - Quantities, discounts, units and sections are never touched. Other products' lines are returned as they were.
 *
 * Saved, sent, accepted and converted quotes, orders and invoices are snapshots: they do not pass through here.
 */
export function refreshLinesForProduct<L extends RefreshableLine>(
  lines: readonly L[],
  before: Pick<CatalogueProduct, 'price' | 'name'> | undefined,
  fresh: Pick<CatalogueProduct, 'id' | 'price' | 'name'>,
  money: (value: number) => string,
): { lines: L[]; notes: RefreshNote[] } {
  const notes: RefreshNote[] = [];
  const price = fresh.price;
  if (price === undefined) return { lines: [...lines], notes };
  const next = lines.map((line, index) => {
    if (line.productId !== fresh.id) return line;
    const manual = line.priceMode === 'manual';
    if (!manual) return line.unitPrice === price ? line : { ...line, unitPrice: price };
    if (before !== undefined && before.price !== price) {
      notes.push({ productId: fresh.id, line: index, message: `${fresh.name}: the catalogue price is now ${money(price)}. This line keeps the price you set.` });
    }
    return line;
  });
  return { lines: next, notes };
}
