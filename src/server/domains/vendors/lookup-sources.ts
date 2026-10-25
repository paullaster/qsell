import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { bankAccounts, glAccounts, paymentMethods, procurementCategories, products, reasonCodes, vendors } from '@/server/db/drizzle/schema';
import { VENDOR_STATUS, VENDOR_TYPES } from '@/lib/vendor-forms';
import { QUESTION_KINDS, STATUS_WORDS } from '@/lib/prequalification';
import { RFQ_STATUS } from '@/lib/rfq';
import { PO_STATUS } from '@/lib/purchase-order';
import { REJECT_REASONS, RGN_STATUS } from '@/lib/rgn';
import { INVOICE_REASONS, INVOICE_STATE } from '@/lib/supplier-invoice';
import { VOUCHER_STATUS } from '@/lib/vendor-payment';
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
  /** The categories vendors are qualified for, as a picker for the parent of a category and for filters. */
  tableSource({
    key: 'procurement-categories',
    permission: 'vendors:read',
    table: procurementCategories,
    id: procurementCategories.id,
    label: procurementCategories.name,
    searchColumns: [procurementCategories.name, procurementCategories.code],
    select: { code: procurementCategories.code, status: procurementCategories.status },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(procurementCategories.companyId, companyId), ne(procurementCategories.status, 'archived')];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: joinText([row.code, row.status]), badge: null, meta: { status: text(row.status) } }),
  }),
  /** The reasons a prequalification can be refused, suspended or revoked for. */
  tableSource({
    key: 'prequal-reasons',
    permission: 'vendors:read',
    table: reasonCodes,
    id: reasonCodes.code,
    label: reasonCodes.description,
    searchColumns: [reasonCodes.description, reasonCodes.code],
    select: { requiresComment: reasonCodes.requiresComment },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(reasonCodes.companyId, companyId), eq(reasonCodes.isActive, true), sql`${reasonCodes.appliesTo} @> '["prequalification_decision"]'::jsonb`];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: null, badge: null, meta: { requiresComment: row.requiresComment === true ? '1' : '' } }),
  }),
  staticSource({
    key: 'prequal-statuses',
    permission: 'vendors:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return Object.entries(STATUS_WORDS).filter(([id]) => id !== 'draft').map(([id, v]) => ({ id, label: v.label, description: null }));
    },
  }),
  staticSource({
    key: 'prequal-question-kinds',
    permission: 'vendors:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return QUESTION_KINDS.map((k) => ({ id: k.id, label: k.label, description: null }));
    },
  }),
  /** The reasons a quote can be refused for. */
  tableSource({
    key: 'rfq-rejection-reasons',
    permission: 'rfq:evaluate',
    table: reasonCodes,
    id: reasonCodes.code,
    label: reasonCodes.description,
    searchColumns: [reasonCodes.description, reasonCodes.code],
    select: { requiresComment: reasonCodes.requiresComment },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(reasonCodes.companyId, companyId), eq(reasonCodes.isActive, true), sql`${reasonCodes.appliesTo} @> '["rfq_rejection"]'::jsonb`];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: null, badge: null, meta: { requiresComment: row.requiresComment === true ? '1' : '' } }),
  }),
  /** Stock items an order line can be for, so receiving it puts the goods into stock. */
  tableSource({
    key: 'po-products',
    permission: 'purchase_orders:create',
    table: products,
    id: products.id,
    label: products.name,
    searchColumns: [products.name, products.sku, products.stockCode],
    select: { sku: products.sku },
    scope: ({ filters }) => {
      acceptFilters(filters, {});
      return [isNull(products.deletedAt)];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: joinText([row.sku]), badge: null }),
  }),
  staticSource({
    key: 'rgn-reject-reasons',
    permission: 'rgn:create',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return REJECT_REASONS.map((r) => ({ id: r.id, label: r.label, description: null }));
    },
  }),
  staticSource({
    key: 'rgn-statuses',
    permission: 'rgn:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return Object.entries(RGN_STATUS).map(([id, v]) => ({ id, label: v.label, description: null }));
    },
  }),
  staticSource({
    key: 'po-statuses',
    permission: 'purchase_orders:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return Object.entries(PO_STATUS).map(([id, v]) => ({ id, label: v.label, description: null }));
    },
  }),
  staticSource({
    key: 'rfq-statuses',
    permission: 'rfq:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return Object.entries(RFQ_STATUS).map(([id, v]) => ({ id, label: v.label, description: null }));
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
  staticSource({
    key: 'invoice-reasons',
    permission: 'supplier_invoices:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return INVOICE_REASONS.map((r) => ({ id: r.code, label: r.label, description: null }));
    },
  }),
  staticSource({
    key: 'invoice-states',
    permission: 'supplier_invoices:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return Object.entries(INVOICE_STATE).filter(([id]) => id !== 'draft').map(([id, v]) => ({ id, label: v.label, description: null }));
    },
  }),
  /** Accounts a line of a supplier invoice that is not stock can be booked to: open, postable by hand. */
  tableSource({
    key: 'invoice-gl-accounts',
    permission: 'supplier_invoices:process',
    table: glAccounts,
    id: glAccounts.id,
    label: glAccounts.no,
    searchColumns: [glAccounts.no, glAccounts.name],
    select: { name: glAccounts.name },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false), eq(glAccounts.postingSource, 'manual'), sql`${glAccounts.category} IN ('expense','assets')`];
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} ${text(row.name)}`, description: null, badge: null }),
  }),
  /** The account the tax on supplier invoices is booked to: any open posting account under assets (the input tax account is a control account). */
  tableSource({
    key: 'invoice-tax-accounts',
    permission: 'vendor_settings:manage',
    table: glAccounts,
    id: glAccounts.id,
    label: glAccounts.no,
    searchColumns: [glAccounts.no, glAccounts.name],
    select: { name: glAccounts.name },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [and(eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false), sql`${glAccounts.category} IN ('assets','liabilities')`)].filter((x): x is NonNullable<typeof x> => x !== undefined);
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} ${text(row.name)}`, description: null, badge: null }),
  }),
  staticSource({
    key: 'voucher-statuses',
    permission: 'vendor_payments:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return Object.entries(VOUCHER_STATUS).map(([id, v]) => ({ id, label: v.label, description: null }));
    },
  }),
  /** The ways of paying a vendor: switched on for vendor payments, with an open bank account behind them. */
  tableSource({
    key: 'vendor-payment-methods',
    permission: 'vendor_payments:read',
    table: paymentMethods,
    id: paymentMethods.id,
    label: paymentMethods.name,
    searchColumns: [paymentMethods.name, paymentMethods.code],
    select: { kind: paymentMethods.kind },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [
        eq(paymentMethods.companyId, companyId),
        eq(paymentMethods.enabled, true),
        sql`${paymentMethods.usableFor} @> '["vendor_payment"]'::jsonb`,
        sql`exists (select 1 from ${bankAccounts} where ${bankAccounts.id} = ${paymentMethods.balancingBankAccountId} and ${bankAccounts.blocked} = false)`,
      ];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.kind).replace('_', ' '), badge: null, meta: { kind: text(row.kind) } }),
  }),
];
