import { QUOTE_STATUS_FILTERS, type QuoteStatusFilter } from '@/lib/quote-statuses';
import {
  cleanQuery,
  decodeCursor,
  type Cursor,
  type Parsed,
} from '@/server/domains/lookups/request';

/** Rows per page when the caller does not say, and the most a page may hold. */
export const QUOTE_LIST_DEFAULT_LIMIT = 25;
export const QUOTE_LIST_MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 100;

/** The quotes list as asked for: a status, some search text, and where the page starts. */
export interface QuoteListRequest {
  query: string;
  status: QuoteStatusFilter;
  limit: number;
  /** The last row of the previous page; null for the first page. */
  after: Cursor | null;
}

const isStatus = (value: unknown): value is QuoteStatusFilter =>
  typeof value === 'string' && (QUOTE_STATUS_FILTERS as readonly string[]).includes(value);

/** Checks a request from the browser (or from the page's address) and fills the defaults. */
export function parseQuoteListRequest(input: unknown): Parsed<QuoteListRequest> {
  const raw = input ?? {};
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: 'Invalid list request.' };
  }
  const { query, status, limit, cursor } = raw as Record<string, unknown>;

  if (query !== undefined && typeof query !== 'string') {
    return { ok: false, error: 'Invalid search text.' };
  }
  const text = cleanQuery(query ?? '');
  if (text.length > MAX_QUERY_LENGTH) {
    return {
      ok: false,
      error: `Search text is limited to ${String(MAX_QUERY_LENGTH)} characters.`,
    };
  }

  if (status !== undefined && !isStatus(status)) {
    return { ok: false, error: 'Unknown status.' };
  }

  let size = QUOTE_LIST_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      return { ok: false, error: 'Invalid page size.' };
    }
    size = Math.min(limit, QUOTE_LIST_MAX_LIMIT);
  }

  let after: Cursor | null = null;
  if (cursor !== undefined && cursor !== null) {
    after = typeof cursor === 'string' ? decodeCursor(cursor) : null;
    if (after === null) return { ok: false, error: 'Invalid page cursor.' };
  }

  return { ok: true, value: { query: text, status: status ?? 'all', limit: size, after } };
}
