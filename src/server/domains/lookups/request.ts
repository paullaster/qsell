import { LOOKUP_DEFAULT_LIMIT, LOOKUP_MAX_LIMIT, LOOKUP_MAX_QUERY_LENGTH } from '@/lib/lookup';

/**
 * Turns whatever arrived from the browser into a request the server can act on, or says why not.
 * Everything from the client is untrusted: types are checked, sizes are capped, and the cursor is
 * decoded and validated here, never passed to the database as it came.
 */
export interface Cursor {
  /** The sort value of the last option the previous page ended on. */
  k: string;
  /** Its id, to break ties. */
  id: string;
}

export interface ParsedLookupRequest {
  source: string;
  query: string;
  limit: number;
  after: Cursor | null;
  filters: Record<string, string>;
}

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MAX_FILTERS = 8;
const MAX_FILTER_VALUE = 100;
const MAX_CURSOR_LENGTH = 600;
const SOURCE_KEY = /^[a-z][a-z0-9-]{0,63}$/;

/** Escapes `%`, `_` and `\` so typed text is matched literally by LIKE. */
export const escapeLike = (term: string): string => term.replace(/[\\%_]/g, (c) => `\\${c}`);

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

export function decodeCursor(raw: string): Cursor | null {
  if (raw.length === 0 || raw.length > MAX_CURSOR_LENGTH) return null;
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (typeof value !== 'object' || value === null) return null;
    const { k, id } = value as Record<string, unknown>;
    if (typeof k !== 'string' || typeof id !== 'string') return null;
    if (k.length > 300 || id.length === 0 || id.length > 100) return null;
    return { k, id };
  } catch {
    return null;
  }
}

/** Search text with control characters removed, trimmed, and capped. */
export function cleanQuery(value: string): string {
  // eslint-disable-next-line no-control-regex -- the point is to strip them
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

export function parseLookupRequest(raw: unknown): Parsed<ParsedLookupRequest> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'Invalid lookup request.' };
  }
  const body = raw as Record<string, unknown>;
  const { source, query, limit, cursor, filters } = body;

  if (typeof source !== 'string' || !SOURCE_KEY.test(source)) {
    return { ok: false, error: 'Unknown list.' };
  }
  if (query !== undefined && typeof query !== 'string') {
    return { ok: false, error: 'Invalid search text.' };
  }
  const cleaned = cleanQuery(query ?? '');
  if (cleaned.length > LOOKUP_MAX_QUERY_LENGTH) {
    return { ok: false, error: `Search text is limited to ${LOOKUP_MAX_QUERY_LENGTH} characters.` };
  }

  let size = LOOKUP_DEFAULT_LIMIT;
  if (limit !== undefined) {
    if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1) {
      return { ok: false, error: 'Invalid page size.' };
    }
    size = Math.min(limit, LOOKUP_MAX_LIMIT);
  }

  let after: Cursor | null = null;
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== 'string') return { ok: false, error: 'Invalid page cursor.' };
    after = decodeCursor(cursor);
    if (after === null) return { ok: false, error: 'Invalid page cursor.' };
  }

  const parsedFilters: Record<string, string> = {};
  if (filters !== undefined) {
    if (typeof filters !== 'object' || filters === null || Array.isArray(filters)) {
      return { ok: false, error: 'Invalid filters.' };
    }
    const entries = Object.entries(filters as Record<string, unknown>);
    if (entries.length > MAX_FILTERS) return { ok: false, error: 'Too many filters.' };
    for (const [name, value] of entries) {
      if (typeof value !== 'string' || value.length > MAX_FILTER_VALUE || !SOURCE_KEY.test(name)) {
        return { ok: false, error: 'Invalid filters.' };
      }
      parsedFilters[name] = value;
    }
  }

  return {
    ok: true,
    value: { source, query: cleaned, limit: size, after, filters: parsedFilters },
  };
}
