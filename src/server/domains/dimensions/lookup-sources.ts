import { eq, ne, sql } from 'drizzle-orm';
import { dimensions, dimensionValues } from '@/server/db/drizzle/schema';
import { acceptFilters, LookupFilterError, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import { DIMENSION_KINDS } from '@/lib/dimension-forms';
import { DIMENSION_OPTION_STRINGS, DIMENSION_OPTION_STRING_LABELS } from './option-strings';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** One optional filter that must be an id; anything else sent is refused. */
function idFilter(filters: Record<string, string>, name: string): string | undefined {
  const { [name]: id, ...rest } = filters;
  if (Object.keys(rest).length > 0) throw new LookupFilterError('Unsupported filter.');
  if (id === undefined) return undefined;
  if (!UUID.test(id)) throw new LookupFilterError('That is not a valid choice.');
  return id;
}

/** The company's dimensions, for choosing a parent; `exclude` leaves out the one being edited. */
const dimensionList = tableSource({
  key: 'dimensions',
  permission: 'settings:read',
  table: dimensions,
  id: dimensions.id,
  label: dimensions.code,
  searchColumns: [dimensions.code, dimensions.name],
  select: { name: dimensions.name },
  scope: ({ companyId, filters }) => {
    const exclude = idFilter(filters, 'exclude');
    return [eq(dimensions.companyId, companyId), ...(exclude === undefined ? [] : [ne(dimensions.id, exclude)])];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} — ${text(row.name)}`, description: null, badge: null }),
});

/** The values of one dimension (the `dimension` filter), for choosing a parent value; `exclude` leaves one out. */
const dimensionValueList = tableSource({
  key: 'dimension-values',
  permission: 'settings:read',
  table: dimensionValues,
  id: dimensionValues.id,
  label: dimensionValues.code,
  searchColumns: [dimensionValues.code, dimensionValues.name],
  select: { name: dimensionValues.name, dimensionCode: dimensionValues.dimensionCode },
  scope: ({ companyId, filters }) => {
    const { dimension, exclude, ...rest } = filters;
    if (Object.keys(rest).length > 0 || dimension === undefined || !UUID.test(dimension)) throw new LookupFilterError('Choose the dimension first.');
    if (exclude !== undefined && !UUID.test(exclude)) throw new LookupFilterError('That is not a valid choice.');
    return [
      // Only values of a dimension in the caller's own company can be reached.
      eq(dimensionValues.dimensionId, dimension),
      sql`exists (select 1 from ${dimensions} where ${dimensions.id} = ${dimensionValues.dimensionId} and ${dimensions.companyId} = ${companyId})`,
      ...(exclude === undefined ? [] : [ne(dimensionValues.id, exclude)]),
    ];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.dimensionCode)}:${text(row.label)} — ${text(row.name)}`, description: null, badge: null }),
});

const optionStrings = staticSource({
  key: 'dimension-option-strings',
  permission: 'settings:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return DIMENSION_OPTION_STRINGS.map((id) => ({ id, label: DIMENSION_OPTION_STRING_LABELS[id], description: null }));
  },
});

const kinds = staticSource({
  key: 'dimension-kinds',
  permission: 'dimensions:manage',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return DIMENSION_KINDS.map((k) => ({ id: k.id, label: k.label, description: null }));
  },
});

export const DIMENSION_LOOKUP_SOURCES: LookupSource[] = [dimensionList, dimensionValueList, optionStrings, kinds];
