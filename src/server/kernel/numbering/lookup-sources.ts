import { and, eq, sql } from 'drizzle-orm';
import { branches, numberSeries, numberSeriesBindings } from '@/server/db/drizzle/schema';
import { RESET_CHOICES } from '@/lib/number-series-forms';
import { acceptFilters, LookupFilterError, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import { isDocumentKind } from './document-kinds';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * Number series a document kind can be numbered by: the active ones; for a fiscal kind only the gap-free
 * ones (the `fiscal` filter), since a fiscal document may never have a missing number.
 */
const seriesSource = tableSource({
  key: 'number-series',
  permission: 'numbering:manage',
  table: numberSeries,
  id: numberSeries.id,
  label: numberSeries.code,
  searchColumns: [numberSeries.code, numberSeries.description],
  select: { description: numberSeries.description, mode: numberSeries.mode },
  scope: ({ companyId, filters }) => {
    const { fiscal } = acceptFilters(filters, { fiscal: ['1'] });
    return [eq(numberSeries.companyId, companyId), eq(numberSeries.isActive, true), ...(fiscal === '1' ? [eq(numberSeries.mode, 'gap_free')] : [])];
  },
  toOption: (row) => ({
    id: text(row.id),
    label: `${text(row.label)} — ${text(row.description)}`,
    description: null,
    badge: row.mode === 'gap_free' ? 'Gap-free' : 'Allows gaps',
  }),
});

/**
 * The company's active branches. The `unbound` filter names a document kind and leaves out the
 * branches that already have their own series for it, so an override is never offered twice.
 */
const branchSource = tableSource({
  key: 'numbering-branches',
  permission: 'numbering:manage',
  table: branches,
  id: branches.id,
  label: branches.name,
  searchColumns: [branches.name, branches.code],
  select: { code: branches.code },
  scope: ({ companyId, filters }) => {
    const { unbound, ...rest } = filters;
    if (Object.keys(rest).length > 0) throw new LookupFilterError('Unsupported filter.');
    if (unbound !== undefined && !isDocumentKind(unbound)) throw new LookupFilterError('That is not a kind of document.');
    return [
      eq(branches.companyId, companyId),
      eq(branches.isActive, true),
      ...(unbound === undefined
        ? []
        : [
            sql`not exists (select 1 from ${numberSeriesBindings} where ${and(eq(numberSeriesBindings.companyId, companyId), eq(numberSeriesBindings.documentKind, unbound), eq(numberSeriesBindings.branchId, branches.id))})`,
          ]),
    ];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} (${text(row.code)})`, description: null, badge: null, meta: { code: text(row.code) } }),
});

const resetModes = staticSource({
  key: 'number-reset-modes',
  permission: 'numbering:manage',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return RESET_CHOICES.map((c) => ({ id: c.id, label: c.label, description: null }));
  },
});

export const NUMBERING_LOOKUP_SOURCES: LookupSource[] = [seriesSource, branchSource, resetModes];
