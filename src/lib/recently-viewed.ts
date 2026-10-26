export const RECENTLY_VIEWED_KEY = 'qsell_recent_v1';
const MAX = 12;

/** The saved list of product ids, newest first. Anything unreadable gives an empty list. */
export function parseRecentlyViewed(raw: string | null | undefined): string[] {
  if (raw === null || raw === undefined) return [];
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return [...new Set(value.filter((id): id is string => typeof id === 'string' && id !== '' && id.length <= 100))].slice(0, MAX);
  } catch {
    return [];
  }
}

/** The list after this product was looked at: it moves to the front and the list stays short. */
export function viewed(list: readonly string[], productId: string): string[] {
  return [productId, ...list.filter((id) => id !== productId)].slice(0, MAX);
}
