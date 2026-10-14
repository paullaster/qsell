import { TEMPLATE_STATUS_FILTERS, type TemplateStatusFilter } from '@/lib/template-statuses';
import {
  cleanQuery,
  decodeCursor,
  type Cursor,
  type Parsed,
} from '@/server/domains/lookups/request';

export const TEMPLATE_LIST_DEFAULT_LIMIT = 25;
export const TEMPLATE_LIST_MAX_LIMIT = 100;
const MAX_QUERY_LENGTH = 100;

/** A list of templates as asked for: some search text, a status, and where the page starts. */
export interface TemplateListRequest {
  query: string;
  status: TemplateStatusFilter;
  limit: number;
  after: Cursor | null;
}

const isStatus = (value: unknown): value is TemplateStatusFilter =>
  typeof value === 'string' && (TEMPLATE_STATUS_FILTERS as readonly string[]).includes(value);

/** Checks a template-list request from the browser and fills the defaults. */
export function parseTemplateListRequest(input: unknown): Parsed<TemplateListRequest> {
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
  if (status !== undefined && !isStatus(status)) return { ok: false, error: 'Unknown status.' };

  let size = TEMPLATE_LIST_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      return { ok: false, error: 'Invalid page size.' };
    }
    size = Math.min(limit, TEMPLATE_LIST_MAX_LIMIT);
  }

  let after: Cursor | null = null;
  if (cursor !== undefined && cursor !== null) {
    after = typeof cursor === 'string' ? decodeCursor(cursor) : null;
    if (after === null) return { ok: false, error: 'Invalid page cursor.' };
  }
  return { ok: true, value: { query: text, status: status ?? 'all', limit: size, after } };
}
