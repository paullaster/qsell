/**
 * What a lookup (the options behind an Autocomplete) sends and gets back. Shared by the server,
 * which decides what can be searched, and the browser, which only asks. Nothing here is trusted
 * on the server: every request is parsed again by `parseLookupRequest`.
 */

/** Options per page when the caller does not say. */
export const LOOKUP_DEFAULT_LIMIT = 20;
/** The most options one page may hold, whatever the caller asks for. */
export const LOOKUP_MAX_LIMIT = 50;
/** Longest search text the server accepts. */
export const LOOKUP_MAX_QUERY_LENGTH = 100;

export interface LookupOption {
  id: string;
  label: string;
  /** A second line under the label. */
  description?: string | null;
  /** A short tag beside the label, such as "Default". */
  badge?: string | null;
  /** Facts about the option the screen needs once it is chosen (a currency, whether a reference is required...). Set by the server. */
  meta?: Record<string, string>;
}

export interface LookupPage {
  options: LookupOption[];
  /** Ask for the next page with this; null when there are no more. */
  nextCursor: string | null;
}

export interface LookupRequest {
  /** Which list to search; a key the server knows. */
  source: string;
  query?: string;
  limit?: number;
  cursor?: string | null;
  /** Narrowing the list, such as `{ status: 'active' }`; each source allows its own. */
  filters?: Record<string, string>;
}

export type LookupResult = { ok: true; data: LookupPage } | { ok: false; error: string };
