import { and, eq, isNull, ne, sql } from 'drizzle-orm';
import { RETURN_REASONS } from '@/lib/purchase-return';
import { LANDED_KINDS } from '@/lib/landed-cost';
import { SOURCE_WORDS } from '@/lib/vendor-scorecard';
import { bankAccounts, glAccounts, paymentMethods, pettyCashFloats, purchaseInvoices, users, procurementCategories, products, reasonCodes, vendors, withholdingCodes } from '@/server/db/drizzle/schema';
import { VENDOR_STATUS, VENDOR_TYPES } from '@/lib/vendor-forms';
import { QUESTION_KINDS, STATUS_WORDS } from '@/lib/prequalification';
import { RFQ_STATUS } from '@/lib/rfq';
import { PO_STATUS } from '@/lib/purchase-order';
import { REJECT_REASONS, RGN_STATUS } from '@/lib/rgn';
import { INVOICE_REASONS, INVOICE_STATE } from '@/lib/supplier-invoice';
import { VOUCHER_STATUS } from '@/lib/vendor-payment';
import { CREDIT_STATE } from '@/lib/vendor-credit-memo';
import { CONTACT_ROLES, DESTINATION_KINDS, ID_TYPES, TURNOVER_BANDS } from '@/lib/vendor-profile';
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
    key: 'ageing-bases',
    permission: 'vendor_payments:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return [
        { id: 'due', label: 'By due date', description: 'How late it is past the date it was due to be paid' },
        { id: 'invoice', label: 'By invoice date', description: 'How old the invoice is, whatever its terms' },
      ];
    },
  }),
  staticSource({
    key: 'ageing-groups',
    permission: 'vendor_payments:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return [
        { id: 'vendor', label: 'Each vendor' },
        { id: 'category', label: 'Each category', description: 'The category of the order the invoice was for' },
        { id: 'posting_group', label: 'Each vendor posting group', description: 'The group that decides which accounts a vendor posts to' },
      ];
    },
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
      ['vendor-destination-kinds', DESTINATION_KINDS],
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
  staticSource({
    key: 'bank-file-formats',
    permission: 'vendor_payments:release',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return [{ id: 'csv', label: 'CSV', description: 'A spreadsheet the bank can read' }, { id: 'pain001', label: 'ISO 20022 (pain.001)', description: 'The standard bulk payment file' }];
    },
  }),
  /** Any account that can be posted to, for choosing the accounts payments post to. */
  tableSource({
    key: 'payment-gl-accounts',
    permission: 'vendor_payments:manage_terms',
    table: glAccounts,
    id: glAccounts.id,
    label: glAccounts.no,
    searchColumns: [glAccounts.no, glAccounts.name],
    select: { name: glAccounts.name },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false)];
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} ${text(row.name)}`, description: null, badge: null }),
  }),
  staticSource({
    key: 'withholding-bases',
    permission: 'vendor_payments:manage_terms',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return [{ id: 'net', label: 'The net amount (before tax)', description: null }, { id: 'gross', label: 'Everything that is paid', description: null }];
    },
  }),
  /** The withholding codes in use, for giving one to a vendor. */
  tableSource({
    key: 'withholding-codes',
    permission: 'vendors:read',
    table: withholdingCodes,
    id: withholdingCodes.id,
    label: withholdingCodes.code,
    searchColumns: [withholdingCodes.code, withholdingCodes.name],
    select: { name: withholdingCodes.name, rate: withholdingCodes.ratePercent, base: withholdingCodes.base },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(withholdingCodes.companyId, companyId), eq(withholdingCodes.active, true)];
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} · ${text(row.name)} (${text(row.rate)}%)`, description: text(row.base) === 'net' ? 'On the net amount' : 'On everything paid', badge: null }),
  }),
  staticSource({
    key: 'credit-memo-reasons',
    permission: 'credit_memos:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return INVOICE_REASONS.map((r) => ({ id: r.code, label: r.label, description: null }));
    },
  }),
  staticSource({
    key: 'credit-memo-states',
    permission: 'credit_memos:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return Object.entries(CREDIT_STATE).filter(([id]) => id !== 'draft').map(([id, v]) => ({ id, label: v.label, description: null }));
    },
  }),
  /** Cash accounts that no float uses yet. */
  tableSource({
    key: 'petty-cash-accounts',
    permission: 'petty_cash:manage',
    table: bankAccounts,
    id: bankAccounts.id,
    label: bankAccounts.name,
    searchColumns: [bankAccounts.name, bankAccounts.code],
    select: { code: bankAccounts.code },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(bankAccounts.companyId, companyId), eq(bankAccounts.kind, 'cash'), eq(bankAccounts.blocked, false), sql`NOT EXISTS (SELECT 1 FROM petty_cash_floats f WHERE f.bank_account_id = ${bankAccounts.id})`];
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.code)} · ${text(row.label)}`, description: null, badge: null }),
  }),
  /** Open asset accounts the cash of a float is kept in. */
  tableSource({
    key: 'petty-cash-gl-accounts',
    permission: 'petty_cash:manage',
    table: glAccounts,
    id: glAccounts.id,
    label: glAccounts.no,
    searchColumns: [glAccounts.no, glAccounts.name],
    select: { name: glAccounts.name },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false), eq(glAccounts.category, 'assets')];
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} ${text(row.name)}`, description: null, badge: null }),
  }),
  /** Staff who can look after a float. */
  tableSource({
    key: 'petty-custodians',
    permission: 'petty_cash:manage',
    table: users,
    id: users.id,
    label: users.name,
    searchColumns: [users.name, users.email],
    select: { email: users.email },
    scope: ({ filters }) => {
      acceptFilters(filters, {});
      return [ne(users.role, 'customer'), ne(users.role, 'vendor'), eq(users.status, 'active')];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.email), badge: null }),
  }),
  staticSource({
    key: 'petty-kinds',
    permission: 'petty_cash:create',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return [{ id: 'expense', label: 'An expense', description: 'No vendor: tea, fuel, a small repair' }, { id: 'vendor_invoice', label: 'A small vendor invoice', description: 'Pays an invoice already booked' }];
    },
  }),
  tableSource({
    key: 'petty-cash-floats',
    permission: 'petty_cash:read',
    table: pettyCashFloats,
    id: pettyCashFloats.id,
    label: pettyCashFloats.name,
    searchColumns: [pettyCashFloats.name, pettyCashFloats.code],
    select: { code: pettyCashFloats.code },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(pettyCashFloats.companyId, companyId), eq(pettyCashFloats.active, true)];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.code), badge: null }),
  }),
  /** Open expense accounts a petty cash payment can be booked to. */
  tableSource({
    key: 'petty-expense-accounts',
    permission: 'petty_cash:create',
    table: glAccounts,
    id: glAccounts.id,
    label: glAccounts.no,
    searchColumns: [glAccounts.no, glAccounts.name],
    select: { name: glAccounts.name },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(glAccounts.companyId, companyId), eq(glAccounts.type, 'posting'), eq(glAccounts.blocked, false), eq(glAccounts.postingSource, 'manual'), sql`${glAccounts.category} IN ('expense','cost_of_sales')`];
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} ${text(row.name)}`, description: null, badge: null }),
  }),
  /** The ways of paying a top-up can come from: any open one. */
  tableSource({
    key: 'petty-topup-methods',
    permission: 'petty_cash:create',
    table: paymentMethods,
    id: paymentMethods.id,
    label: paymentMethods.name,
    searchColumns: [paymentMethods.name, paymentMethods.code],
    select: { kind: paymentMethods.kind },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true), sql`exists (select 1 from ${bankAccounts} where ${bankAccounts.id} = ${paymentMethods.balancingBankAccountId} and ${bankAccounts.blocked} = false)`];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.kind).replace('_', ' '), badge: null }),
  }),
  /** Booked vendor invoices that still have something open. */
  tableSource({
    key: 'payable-invoices',
    permission: 'petty_cash:create',
    table: purchaseInvoices,
    id: purchaseInvoices.id,
    label: purchaseInvoices.vendorInvoiceNo,
    searchColumns: [purchaseInvoices.vendorInvoiceNo, purchaseInvoices.number],
    select: {
      number: purchaseInvoices.number,
      vendor: sql<string>`(select ${vendors.legalName} from ${vendors} where ${vendors.id} = ${purchaseInvoices.vendorId})`,
      open: sql<string>`(select e.remaining_amount::text from vendor_ledger_entries e where e.id = ${purchaseInvoices.ledgerEntryId})`,
    },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(purchaseInvoices.companyId, companyId), sql`exists (select 1 from vendor_ledger_entries e where e.id = ${purchaseInvoices.ledgerEntryId} and e.remaining_amount > 0)`];
    },
    toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} · ${text(row.vendor)}`, description: `Open ${text(row.open)} · ${text(row.number)}`, badge: null, meta: { vendor: text(row.vendor), open: text(row.open) } }),
  }),
  /** The ways of paying money can come back through: any open one with a usable bank account. */
  tableSource({
    key: 'vendor-refund-methods',
    permission: 'vendor_refunds:create',
    table: paymentMethods,
    id: paymentMethods.id,
    label: paymentMethods.name,
    searchColumns: [paymentMethods.name, paymentMethods.code],
    select: { kind: paymentMethods.kind },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true), sql`exists (select 1 from ${bankAccounts} where ${bankAccounts.id} = ${paymentMethods.balancingBankAccountId} and ${bankAccounts.blocked} = false)`];
    },
    toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.kind).replace('_', ' '), badge: null }),
  }),
  staticSource({
    key: 'purchase-return-reasons',
    permission: 'purchase_returns:create',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return RETURN_REASONS.map((r) => ({ id: r.id, label: r.label }));
    },
  }),
  staticSource({
    key: 'landed-cost-kinds',
    permission: 'landed_costs:create',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return LANDED_KINDS.map((k) => ({ id: k.id, label: k.label }));
    },
  }),
  staticSource({
    key: 'landed-cost-methods',
    permission: 'landed_costs:create',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return [{ id: 'value', label: 'By the value of the goods' }, { id: 'quantity', label: 'By the quantity of the goods' }];
    },
  }),
  staticSource({
    key: 'scorecard-sources',
    permission: 'scorecards:manage',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return Object.entries(SOURCE_WORDS).map(([id, label]) => ({ id, label }));
    },
  }),
];
