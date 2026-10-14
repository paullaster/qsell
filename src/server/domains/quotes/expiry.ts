/** Statuses after which a quote's valid-until date no longer matters. */
export const CLOSED_QUOTE_STATUSES: readonly string[] = ['converted', 'rejected', 'cancelled'];

/** True when a quote is past its valid-until date and still open. */
export function isQuoteExpired(
  quote: { validUntil: Date | null; status: string },
  now: Date,
): boolean {
  return (
    quote.validUntil !== null &&
    quote.validUntil < now &&
    !CLOSED_QUOTE_STATUSES.includes(quote.status)
  );
}
