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
  /**
   * Also open to a signed-in vendor portal user, who holds no staff permission. Only for fixed lists that say nothing about
   * any company's data (kinds of ID, contact roles); everything else stays behind `permission` alone.
   */
  vendorPortal?: boolean;
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
  select: Record<string, AnyPgColumn | SQL>;
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

interface StaticSourceConfig {
  key: string;
  permission: PermissionKey;
  /** See {@link LookupSource.vendorPortal}. */
  vendorPortal?: boolean;
  /** The whole list, when it is small and fixed or comes from code; may depend on the filters. */
  items: (input: SourceInput) => Promise<LookupOption[]> | LookupOption[];
}

/**
 * A source over a short list the server already has (not a table), such as the payment methods.
 * It is searched and paged the same way as any other, so the browser cannot tell the difference:
 * typed text is compared with the label and description, and the cursor is the last label seen.
 */
export function staticSource(config: StaticSourceConfig): LookupSource {
  return {
    key: config.key,
    permission: config.permission,
    vendorPortal: config.vendorPortal,
    async search(input) {
      const needle = input.query.toLowerCase();
      const all = (await config.items(input))
        .filter(
          (option) =>
            needle === '' ||
            option.label.toLowerCase().includes(needle) ||
            (option.description ?? '').toLowerCase().includes(needle),
        )
        .sort((a, b) => {
          const byLabel = a.label.localeCompare(b.label);
          return byLabel === 0 ? a.id.localeCompare(b.id) : byLabel;
        });
      const after = input.after;
      const rest =
        after === null
          ? all
          : all.filter(
              (option) =>
                option.label.localeCompare(after.k) > 0 ||
                (option.label === after.k && option.id.localeCompare(after.id) > 0),
            );
      const page = rest.slice(0, input.limit);
      const last = page.at(-1);
      return {
        options: page,
        nextCursor:
          rest.length > input.limit && last !== undefined
            ? encodeCursor({ k: last.label, id: last.id })
            : null,
      };
    },
  };
}
