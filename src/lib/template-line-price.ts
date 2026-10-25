/**
 * Prices on template items. An item is priced from the catalogue (no price kept; the price lists
 * answer when the template is used) or at a fixed price kept on the item. A missing price must
 * never turn into a quiet 0, because a fixed 0 would be copied into every quote made from it.
 */
type Mode = 'catalog' | 'fixed';

/** The kept price when the price source changes: none for the catalogue, else the old or standard price, else none. */
export function priceOnModeChange(
  mode: Mode,
  current: number | null | undefined,
  standardPrice: number | null | undefined,
): number | null {
  return mode === 'catalog' ? null : (current ?? standardPrice ?? null);
}

/** What a price box holds as a price: empty is no price, not 0. */
export function readPriceInput(raw: string): number | null {
  if (raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

/** Index of the first fixed-price item that has no price, or -1. */
export function firstUnpricedFixed(
  lines: { priceMode: Mode; unitPrice?: number | null }[],
): number {
  return lines.findIndex(
    (line) =>
      line.priceMode === 'fixed' && (line.unitPrice === null || line.unitPrice === undefined),
  );
}

export const unpricedFixedMessage = (name: string): string =>
  `${name} is set to a fixed price but has none. Type its price or use the catalog price.`;
