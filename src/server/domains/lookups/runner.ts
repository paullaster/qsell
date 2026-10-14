import { and, asc, ilike, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, PgTable } from 'drizzle-orm/pg-core';
import { drizzleDb } from '@/server/db/drizzle/client';
import type { LookupOption, LookupPage } from '@/lib/lookup';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { encodeCursor, escapeLike, type ParsedLookupRequest } from './request';

/**
 * A list the Autocomplete can search. The server decides everything here: who may read it, which
 * columns the typed text is compared with, how it is ordered, and which filters exist. The browser
 * only names the source and sends text, so it can never widen what is searched or read.
 */
export interface LookupSource {
  key: string;
  permission: PermissionKey;
  /** Narrows by the filters a caller may send; unknown filters are an error, not ignored. */
  search: (input: SourceInput) => Promise<LookupPage>;
}

export interface SourceInput {
  companyId: string;
  query: string;
  limit: number;
  after: ParsedLookupRequest['after'];
  filters: Record<string, string>;
}

export class LookupFilterError extends Error {}

/** Rejects a filter the source does not offer, or a value it does not accept. */
export function acceptFilters(
  given: Record<string, string>,
  allowed: Record<string, readonly string[]>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(given)) {
    if (!Object.hasOwn(allowed, name) || !allowed[name].includes(value)) {
      throw new LookupFilterError('Unsupported filter.');
    }
    result[name] = value;
  }
  return result;
}

interface TableSourceConfig {
  key: string;
  permission: PermissionKey;
  table: PgTable;
  id: AnyPgColumn;
  /** The column the list is ordered by and the cursor is built on. */
  label: AnyPgColumn;
  /** Columns the typed text is compared with (any one matching is enough). */
  searchColumns: AnyPgColumn[];
  /** Conditions that always apply: the company, and whatever the filters say. */
  scope: (input: SourceInput) => SQL[];
  toOption: (row: Record<string, unknown>) => LookupOption;
  /** Extra columns to read for `toOption`, by name. */
  select: Record<string, AnyPgColumn>;
}

/**
 * Builds a source over one table: case-insensitive contains-search across `searchColumns`, ordered
 * by `label` then `id`, paged by a keyset cursor (so page 5,000 costs the same as page 1) and
 * limited to one page plus one row to learn whether another page exists.
 */
export function tableSource(config: TableSourceConfig): LookupSource {
  return {
    key: config.key,
    permission: config.permission,
    async search(input) {
      const pattern = `%${escapeLike(input.query)}%`;
      const conditions: (SQL | undefined)[] = [
        ...config.scope(input),
        input.query === ''
          ? undefined
          : or(...config.searchColumns.map((column) => ilike(column, pattern))),
        input.after === null
          ? undefined
          : sql`(${config.label}, ${config.id}) > (${input.after.k}, ${input.after.id})`,
      ];
      const rows = await drizzleDb
        .select({ id: config.id, label: config.label, ...config.select })
        .from(config.table)
        .where(and(...conditions))
        .orderBy(asc(config.label), asc(config.id))
        .limit(input.limit + 1);
      const page = rows.slice(0, input.limit);
      const last = page.at(-1);
      return {
        options: page.map((row) => config.toOption(row as Record<string, unknown>)),
        nextCursor:
          rows.length > input.limit && last !== undefined
            ? encodeCursor({ k: String(last.label), id: String(last.id) })
            : null,
      };
    },
  };
}
