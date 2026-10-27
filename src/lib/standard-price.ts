/**
 * The standard price of an item is the price the pricing engine starts from. It is empty by default, in which case it is the selling
 * price (so an item priced the old way behaves exactly as before); once someone with the right permission sets it, it stands on
 * its own and the selling price is left as it is.
 */
export function effectiveStandardPrice(item: { price?: number | null; standardPrice?: number | null }): number | null {
  const own = item.standardPrice;
  if (typeof own === 'number' && Number.isFinite(own) && own >= 0) return own;
  const selling = item.price;
  return typeof selling === 'number' && Number.isFinite(selling) ? selling : null;
}

/** Whether the standard price is its own value, not just following the selling price. */
export const hasOwnStandardPrice = (item: { standardPrice?: number | null }): boolean =>
  typeof item.standardPrice === 'number' && Number.isFinite(item.standardPrice);
