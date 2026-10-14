import { and, eq } from 'drizzle-orm';
import { drizzleDb } from '@/server/db/drizzle/client';
import {
  currencies,
  customers,
  salesQuoteTemplates,
  salesSectionTemplates,
} from '@/server/db/drizzle/schema';
import { methodLabel, QUOTE_PAYMENT_METHODS } from '@/lib/payment-method-labels';
import { QUOTE_STATUS_FILTERS, statusFilterLabel } from '@/lib/quote-statuses';
import { TEMPLATE_STATUS_FILTERS, templateStatusLabel } from '@/lib/template-statuses';
import {
  acceptFilters,
  LookupFilterError,
  staticSource,
  tableSource,
  type LookupSource,
} from './runner';
import { PAYMENT_LOOKUP_SOURCES } from '@/server/domains/payments/lookup-sources';

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

const tradeCustomers = tableSource({
  key: 'trade-customers',
  permission: 'customers:read',
  table: customers,
  id: customers.id,
  label: customers.name,
  searchColumns: [customers.name, customers.number, customers.email, customers.phone],
  select: { number: customers.number, email: customers.email, accountType: customers.accountType },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(customers.companyId, companyId), eq(customers.isActive, true)];
  },
  toOption: (row) => ({
    id: String(row.id),
    label: String(row.label),
    description: joinText([row.number, row.email]),
    badge: row.accountType === 'credit' ? 'Credit' : null,
  }),
});

const enabledCurrencies = tableSource({
  key: 'currencies',
  permission: 'quotes:read',
  table: currencies,
  id: currencies.code,
  label: currencies.code,
  searchColumns: [currencies.code, currencies.name],
  select: { name: currencies.name, symbol: currencies.symbol, isBase: currencies.isBaseCurrency },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [eq(currencies.isEnabled, true)];
  },
  toOption: (row) => ({
    id: String(row.id),
    label: String(row.label),
    description: joinText([row.name]),
    badge: row.isBase === true ? 'Base' : null,
  }),
});

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** How a quote can be paid. "On account" is offered only when the quote's customer has credit. */
const paymentMethods = staticSource({
  key: 'payment-methods',
  permission: 'quotes:read',
  async items({ companyId, filters }) {
    const { customer = '', ...rest } = filters;
    if (Object.keys(rest).length > 0) throw new LookupFilterError('Unsupported filter.');
    const methods = [...QUOTE_PAYMENT_METHODS];
    if (customer !== '') {
      if (!UUID.test(customer)) throw new LookupFilterError('Unsupported filter.');
      const rows = await drizzleDb
        .select({ accountType: customers.accountType })
        .from(customers)
        .where(and(eq(customers.id, customer), eq(customers.companyId, companyId)));
      if (rows.at(0)?.accountType === 'credit') methods.push('on_account');
    }
    return methods.map((method) => ({ id: method, label: methodLabel(method), description: null }));
  },
});

/** The states to filter the quotes list by. */
const quoteStatuses = staticSource({
  key: 'quote-statuses',
  permission: 'quotes:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return QUOTE_STATUS_FILTERS.map((status) => ({
      id: status,
      label: statusFilterLabel(status),
      description: null,
    }));
  },
});

/** The states to filter the template lists by. */
const templateStatuses = staticSource({
  key: 'template-statuses',
  permission: 'quotes:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return TEMPLATE_STATUS_FILTERS.map((status) => ({
      id: status,
      label: templateStatusLabel(status),
      description: null,
    }));
  },
});

const SOURCES: ReadonlyMap<string, LookupSource> = new Map(
  [
    quoteTemplates,
    sectionTemplates,
    tradeCustomers,
    enabledCurrencies,
    paymentMethods,
    quoteStatuses,
    templateStatuses,
    ...PAYMENT_LOOKUP_SOURCES,
  ].map((source) => [source.key, source]),
);

export const getLookupSource = (key: string): LookupSource | undefined => SOURCES.get(key);
