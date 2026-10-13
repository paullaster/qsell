/**
 * Server action errors are masked in production, so a message thrown from a quote action never
 * reaches the screen. The actions that can fail for a reason the person should read return it as data.
 */
export type QuoteActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

/** Hands back the value, or throws the server's message so existing `catch` blocks show it. */
export function unwrapQuoteAction<T>(result: QuoteActionResult<T>): T {
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
