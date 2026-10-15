import { ilike, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { decodeCursor, encodeCursor, escapeLike } from '@/server/domains/lookups/request';

export const PAGE_SIZE = 25;

export interface PageInput {
  query?: string;
  cursor?: string | null;
}

/** The text typed in the search box, cut to a sane length. */
export const searchText = (input: PageInput): string => (typeof input.query === 'string' ? input.query.trim().slice(0, 100) : '');

/** Rows whose any of these columns contain the text (case-insensitive); nothing when no text. */
export function matching(query: string, columns: AnyPgColumn[]): SQL | undefined {
  if (query === '') return undefined;
  const pattern = `%${escapeLike(query)}%`;
  return or(...columns.map((column) => ilike(column, pattern)));
}

/** Rows after the cursor in (key, id) order; a bad or missing cursor starts from the top. */
export function afterCursor(cursor: string | null | undefined, key: AnyPgColumn, id: AnyPgColumn): SQL | undefined {
  const after = typeof cursor === 'string' && cursor !== '' ? decodeCursor(cursor) : null;
  return after === null ? undefined : sql`(${key}, ${id}) > (${after.k}, ${after.id})`;
}

/** One page out of `limit + 1` rows read: the rows to show, and where the next page begins. */
export function pageOf<Row>(rows: Row[], limit: number, cursorOf: (row: Row) => { k: string; id: string }): { rows: Row[]; nextCursor: string | null } {
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, nextCursor: rows.length > limit && last !== undefined ? encodeCursor(cursorOf(last)) : null };
}
