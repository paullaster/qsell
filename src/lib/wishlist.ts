export const WISHLIST_KEY = 'qsell_wishlist_v1';
export const WISHLIST_MAX = 200;

/** A saved list of product ids, newest first. Anything unreadable gives an empty list. */
export function parseWishlist(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === 'string' && id !== '' && id.length <= 100))].slice(0, WISHLIST_MAX);
  } catch {
    return [];
  }
}

/** The list with this product added at the front, or taken out when `on` is false. */
export function withProduct(list: readonly string[], productId: string, on: boolean): string[] {
  const rest = list.filter((id) => id !== productId);
  return on ? [productId, ...rest].slice(0, WISHLIST_MAX) : rest;
}

/** Two lists joined (what a guest saved, then what the account already had), each product once. */
export function mergeWishlists(first: readonly string[], second: readonly string[]): string[] {
  return [...new Set([...first, ...second])].slice(0, WISHLIST_MAX);
}
