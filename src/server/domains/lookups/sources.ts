import { eq } from 'drizzle-orm';
import { salesQuoteTemplates, salesSectionTemplates } from '@/server/db/drizzle/schema';
import { acceptFilters, tableSource, type LookupSource } from './runner';

/** The non-empty strings joined with a dot, or null when there are none. */
function joinText(parts: unknown[]): string | null {
  const text = parts.filter((v): v is string => typeof v === 'string' && v !== '').join(' · ');
  return text === '' ? null : text;
}

const STATUS_FILTER = { status: ['active', 'archived'] } as const;

/**
 * The lists an Autocomplete may search. Add a list here, with its permission and the columns it is
 * searched by, and every Autocomplete can use it by key. Nothing else can be reached.
 */
const quoteTemplates = tableSource({
  key: 'quote-templates',
  permission: 'quotes:read',
  table: salesQuoteTemplates,
  id: salesQuoteTemplates.id,
  label: salesQuoteTemplates.name,
  searchColumns: [
    salesQuoteTemplates.name,
    salesQuoteTemplates.category,
    salesQuoteTemplates.description,
  ],
  select: {
    category: salesQuoteTemplates.category,
    description: salesQuoteTemplates.description,
    isDefault: salesQuoteTemplates.isDefault,
  },
  scope: ({ companyId, filters }) => {
    const { status = 'active' } = acceptFilters(filters, STATUS_FILTER);
    return [eq(salesQuoteTemplates.companyId, companyId), eq(salesQuoteTemplates.status, status)];
  },
  toOption: (row) => ({
    id: String(row.id),
    label: String(row.label),
    description: joinText([row.category, row.description]),
    badge: row.isDefault === true ? 'Default' : null,
  }),
});

const sectionTemplates = tableSource({
  key: 'section-templates',
  permission: 'quotes:read',
  table: salesSectionTemplates,
  id: salesSectionTemplates.id,
  label: salesSectionTemplates.name,
  searchColumns: [
    salesSectionTemplates.name,
    salesSectionTemplates.category,
    salesSectionTemplates.description,
    salesSectionTemplates.sectionTitle,
  ],
  select: {
    category: salesSectionTemplates.category,
    description: salesSectionTemplates.description,
    sectionTitle: salesSectionTemplates.sectionTitle,
  },
  scope: ({ companyId, filters }) => {
    const { status = 'active' } = acceptFilters(filters, STATUS_FILTER);
    return [
      eq(salesSectionTemplates.companyId, companyId),
      eq(salesSectionTemplates.status, status),
    ];
  },
  toOption: (row) => ({
    id: String(row.id),
    label: String(row.label),
    description: `Section “${String(row.sectionTitle)}”`,
    badge: null,
  }),
});

const SOURCES: ReadonlyMap<string, LookupSource> = new Map(
  [quoteTemplates, sectionTemplates].map((source) => [source.key, source]),
);

export const getLookupSource = (key: string): LookupSource | undefined => SOURCES.get(key);
