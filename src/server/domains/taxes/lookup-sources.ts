import { eq } from 'drizzle-orm';
import { taxCategories } from '@/server/db/drizzle/schema';
import { ETIMS_TAX_CODES, TIMS_TAX_CODES } from '@/lib/kraTaxCodes';
import { PRICING_MODELS, TAX_TYPES } from '@/lib/tax-forms';
import { acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

const fixed = (key: string, list: readonly { id: string; label: string }[]) =>
  staticSource({
    key,
    permission: 'taxes:manage',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return list.map((c) => ({ ...c, description: null }));
    },
  });

/** The tax rules, for choosing one to try (the default first). */
const rules = tableSource({
  key: 'tax-categories',
  permission: 'taxes:manage',
  table: taxCategories,
  id: taxCategories.id,
  label: taxCategories.name,
  searchColumns: [taxCategories.name, taxCategories.code],
  select: { rate: taxCategories.rate, isInclusive: taxCategories.isInclusive, isDefault: taxCategories.isDefault },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [eq(taxCategories.isActive, true)];
  },
  toOption: (row) => ({
    id: text(row.id),
    label: `${text(row.label)} (${text(row.rate)}%) - ${row.isInclusive === true ? 'Inclusive' : 'Exclusive'}`,
    description: null,
    badge: row.isDefault === true ? 'Default' : null,
    meta: { rate: text(row.rate), inclusive: row.isInclusive === true ? '1' : '' },
  }),
});

export const TAX_LOOKUP_SOURCES: LookupSource[] = [
  fixed('tax-types', TAX_TYPES),
  fixed('tax-pricing-models', PRICING_MODELS),
  fixed('kra-tims-codes', TIMS_TAX_CODES.map((o) => ({ id: o.code, label: o.label }))),
  fixed('kra-etims-codes', ETIMS_TAX_CODES.map((o) => ({ id: o.code, label: o.label }))),
  rules,
];
