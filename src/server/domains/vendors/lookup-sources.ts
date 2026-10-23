import { eq, ne } from 'drizzle-orm';
import { vendors } from '@/server/db/drizzle/schema';
import { VENDOR_STATUS, VENDOR_TYPES } from '@/lib/vendor-forms';
import { acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');
const joinText = (parts: unknown[]): string | null => {
  const out = parts.filter((p): p is string => typeof p === 'string' && p !== '').join(' · ');
  return out === '' ? null : out;
};

/** Lists the vendor screens pick from. Each is behind a permission and searched on the server, a page at a time. */
export const VENDOR_LOOKUP_SOURCES: LookupSource[] = [
  tableSource({
    key: 'vendors',
    permission: 'vendors:read',
    table: vendors,
    id: vendors.id,
    label: vendors.legalName,
    searchColumns: [vendors.legalName, vendors.tradingName, vendors.number, vendors.email, vendors.taxId],
    select: { number: vendors.number, email: vendors.email, status: vendors.status, block: vendors.block },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(vendors.companyId, companyId), ne(vendors.status, 'archived')];
    },
    toOption: (row) => ({
      id: text(row.id),
      label: text(row.label),
      description: joinText([row.number, row.email]),
      badge: row.block === 'none' ? null : 'Blocked',
      meta: { number: text(row.number), status: text(row.status), block: text(row.block) },
    }),
  }),
  staticSource({
    key: 'vendor-statuses',
    permission: 'vendors:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return Object.entries(VENDOR_STATUS).map(([id, v]) => ({ id, label: v.label, description: null }));
    },
  }),
  staticSource({
    key: 'vendor-types',
    permission: 'vendors:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return VENDOR_TYPES.map((t) => ({ id: t.id, label: t.label, description: null }));
    },
  }),
];

