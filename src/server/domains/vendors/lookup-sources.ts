import { eq, ne, sql } from 'drizzle-orm';
import { reasonCodes, vendors } from '@/server/db/drizzle/schema';
import { VENDOR_STATUS, VENDOR_TYPES } from '@/lib/vendor-forms';
import { CONTACT_ROLES, ID_TYPES, TURNOVER_BANDS } from '@/lib/vendor-profile';
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
  /** The reasons a vendor application can be refused for (a company adds its own under the same use). */
  tableSource({
    key: 'vendor-rejection-reasons',
    permission: 'vendors:reject',
    table: reasonCodes,
    id: reasonCodes.code,
    label: reasonCodes.description,
    searchColumns: [reasonCodes.description, reasonCodes.code],
    select: { requiresComment: reasonCodes.requiresComment },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(reasonCodes.companyId, companyId), eq(reasonCodes.isActive, true), sql`${reasonCodes.appliesTo} @> '["vendor_rejection"]'::jsonb`];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: null, badge: null, meta: { requiresComment: row.requiresComment === true ? '1' : '' } }),
  }),
  /** The reasons a vendor is suspended, blocked or archived for (a company adds its own under the same use). */
  tableSource({
    key: 'vendor-standing-reasons',
    permission: 'vendors:read',
    table: reasonCodes,
    id: reasonCodes.code,
    label: reasonCodes.description,
    searchColumns: [reasonCodes.description, reasonCodes.code],
    select: { requiresComment: reasonCodes.requiresComment },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(reasonCodes.companyId, companyId), eq(reasonCodes.isActive, true), sql`${reasonCodes.appliesTo} @> '["vendor_standing"]'::jsonb`];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: null, badge: null, meta: { requiresComment: row.requiresComment === true ? '1' : '' } }),
  }),
  staticSource({
    key: 'vendor-block-kinds',
    permission: 'vendors:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return [
        { id: 'payment', label: 'Payments only', description: 'Invoices are still received; no payment is made' },
        { id: 'all', label: 'Everything', description: 'No new document of any kind is accepted' },
      ];
    },
  }),
  staticSource({
    key: 'vendor-portal-roles',
    permission: 'vendors:read',
    vendorPortal: true,
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return [
        { id: 'finance', label: 'Finance', description: 'Bank details and payment terms, documents, invoices' },
        { id: 'sales', label: 'Sales', description: 'Contacts, documents, quotations' },
        { id: 'readonly', label: 'Read-only', description: 'Can see everything their role allows, change nothing' },
      ];
    },
  }),
  staticSource({
    key: 'vendor-expiry-windows',
    permission: 'vendors:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return [30, 60, 90, 180, 365].map((d) => ({ id: String(d), label: `Within ${String(d)} days`, description: null }));
    },
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
    vendorPortal: true,
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return VENDOR_TYPES.map((t) => ({ id: t.id, label: t.label, description: null }));
    },
  }),
  ...(
    [
      ['vendor-id-types', ID_TYPES],
      ['vendor-turnover-bands', TURNOVER_BANDS],
      ['vendor-contact-roles', CONTACT_ROLES],
    ] as const
  ).map(([key, list]) =>
    staticSource({
      key,
      permission: 'vendors:read',
      vendorPortal: true,
      items: ({ filters }) => {
        acceptFilters(filters, {});
        return list.map((x) => ({ id: x.id, label: x.label, description: null }));
      },
    }),
  ),
];
