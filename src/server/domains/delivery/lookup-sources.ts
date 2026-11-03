import { DISPOSITION_WORDS, ISSUE_MOMENTS, ISSUE_MOMENT_WORDS, RETURN_DISPOSITIONS } from '@/lib/stock-issue';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { branches, customerGroups, deliveryZones, products } from '@/server/db/drizzle/schema';
import { DELIVERY_STATUSES, FAILURE_REASONS, STATUS_WORDS } from '@/lib/delivery-document';
import { acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import { CHANNELS } from '@/server/domains/pricing/domain/types';

const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The words for the parts of the business a charge can be limited to. */
export const CHANNEL_WORDS: Record<string, string> = { ecommerce: 'Web shop', sales_order: 'Sales orders', credit_sale: 'Credit sales', pos_cash_sale: 'Point of sale' };

/** The delivery zones, for choosing one in a rate or an area. Stopped zones are not offered. */
const zones = tableSource({
  key: 'delivery-zones',
  permission: 'deliveries:read',
  table: deliveryZones,
  id: deliveryZones.id,
  label: deliveryZones.code,
  searchColumns: [deliveryZones.code, deliveryZones.name],
  select: { name: deliveryZones.name },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(deliveryZones.companyId, companyId), eq(deliveryZones.isActive, true)) ?? sql`false`];
  },
  toOption: (row) => ({
    id: typeof row.id === 'string' ? row.id : '',
    label: `${typeof row.label === 'string' ? row.label : ''} · ${typeof row.name === 'string' ? row.name : ''}`,
    description: null,
    badge: null,
  }),
});

/** The branches, for choosing where a delivery leaves from or who a charge is for. Open branches only. Read with the delivery permission, not the branch one. */
const deliveryBranches = tableSource({
  key: 'delivery-branches',
  permission: 'deliveries:read',
  table: branches,
  id: branches.id,
  label: branches.name,
  searchColumns: [branches.name, branches.code],
  select: { code: branches.code },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [and(eq(branches.companyId, companyId), eq(branches.isActive, true)) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.code)} — ${text(row.label)}`, description: null, badge: null }),
});

/** The customer groups, for limiting a charge to a group. */
const deliveryCustomerGroups = tableSource({
  key: 'delivery-customer-groups',
  permission: 'deliveries:read',
  table: customerGroups,
  id: customerGroups.id,
  label: customerGroups.name,
  searchColumns: [customerGroups.name, customerGroups.code],
  select: { code: customerGroups.code },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [eq(customerGroups.companyId, companyId)];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} (${text(row.code)})`, description: null, badge: null }),
});

/** The parts of the business that make sales, for limiting a charge to one. */
const deliveryChannels = staticSource({
  key: 'delivery-channels',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return CHANNELS.map((id) => ({ id, label: CHANNEL_WORDS[id] ?? id, description: null }));
  },
});

/** The items that can stand for the delivery service on an invoice: live services only; the tax each carries is shown so a mismatch is seen at once. */
const serviceProducts = tableSource({
  key: 'delivery-service-products',
  permission: 'deliveries:read',
  table: products,
  id: products.id,
  label: products.name,
  searchColumns: [products.name, products.sku],
  select: { sku: products.sku, tax: products.taxRate },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [and(isNull(products.deletedAt), eq(products.isActive, true), eq(products.inventoryKind, 'service')) ?? sql`false`];
  },
  toOption: (row) => ({ id: text(row.id), label: `${text(row.label)} (${text(row.sku)})`, description: row.tax === null || row.tax === undefined ? 'No tax rate set' : `Tax ${text(row.tax)}%`, badge: null }),
});

/** The states a delivery can be in, for filtering the deliveries list. */
const deliveryStatuses = staticSource({
  key: 'delivery-statuses',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return DELIVERY_STATUSES.map((status) => ({ id: status, label: STATUS_WORDS[status], description: null, badge: null }));
  },
});

/** Why a delivery attempt can fail, for the person who records it. */
const deliveryFailureReasons = staticSource({
  key: 'delivery-failure-reasons',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return FAILURE_REASONS.map((r) => ({ id: r.code, label: r.words, description: null, badge: null }));
  },
});

/** When the stock of a delivered order leaves the shelf. */
const stockIssueMoments = staticSource({
  key: 'stock-issue-moments',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return ISSUE_MOMENTS.map((id) => ({ id, label: ISSUE_MOMENT_WORDS[id].name, description: ISSUE_MOMENT_WORDS[id].means, badge: null }));
  },
});

/** What can be done with goods that came back. Which of these fit a product is the server's to say when it is received. */
const returnDispositions = staticSource({
  key: 'delivery-return-dispositions',
  permission: 'deliveries:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return RETURN_DISPOSITIONS.map((id) => ({ id, label: DISPOSITION_WORDS[id].name, description: DISPOSITION_WORDS[id].means, badge: null }));
  },
});

export const DELIVERY_LOOKUP_SOURCES: LookupSource[] = [zones, deliveryBranches, deliveryCustomerGroups, deliveryChannels, serviceProducts, deliveryStatuses, deliveryFailureReasons, stockIssueMoments, returnDispositions];
