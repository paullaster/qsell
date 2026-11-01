import { and, eq, isNull, ne, sql, type SQL } from 'drizzle-orm';
import { products, stockLocations } from '@/server/db/drizzle/schema';
import { LOCATION_KINDS, isSalesChannel } from '@/lib/stock';
import { COUNT_STATES, COUNT_STATE_WORDS, TRANSFER_STATES, TRANSFER_STATE_WORDS } from '@/lib/stock-documents';
import { LookupFilterError, acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const text = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The places stock can be held, for choosing where a transfer leaves, arrives, or a count is made. Active places only, and never the
 * transit places the system makes for transfers on their way. Filters: `exclude` (one place left out, such as the sender when
 * choosing the receiver) and `channel` (only places that sell to that sales channel).
 */
const locations = tableSource({
  key: 'stock-locations',
  permission: 'stock:read',
  table: stockLocations,
  id: stockLocations.id,
  label: stockLocations.code,
  searchColumns: [stockLocations.code, stockLocations.name],
  select: { name: stockLocations.name, kind: stockLocations.kind, isDefault: stockLocations.isDefault },
  scope: ({ filters }) => {
    const { exclude, channel, ...rest } = filters;
    if (Object.keys(rest).length > 0) throw new LookupFilterError('Unsupported filter.');
    const conditions: SQL[] = [
      eq(stockLocations.isActive, true),
      ne(stockLocations.kind, 'transit'),
      sql`${stockLocations.companyId} = stock_current_company()`,
    ];
    if (exclude !== undefined) {
      if (!UUID.test(exclude)) throw new LookupFilterError('That is not a valid choice.');
      conditions.push(ne(stockLocations.id, exclude));
    }
    if (channel !== undefined) {
      if (!isSalesChannel(channel)) throw new LookupFilterError('That is not a valid choice.');
      conditions.push(sql`${channel} = ANY (${stockLocations.sellsChannels})`);
    }
    return [and(...conditions) ?? eq(stockLocations.isActive, true)];
  },
  toOption: (row) => ({
    id: text(row.id),
    label: `${text(row.label)} · ${text(row.name)}`,
    description: null,
    badge: row.isDefault === true ? 'Default' : null,
    meta: { code: text(row.label), name: text(row.name), kind: text(row.kind) },
  }),
});

/**
 * Products to put on a transfer or a count. With the filter `at` (a location), only products that have stock there: a transfer can
 * only send what the sender holds. Never shows how much, only that there is some.
 */
const stockProducts = tableSource({
  key: 'stock-products',
  permission: 'stock:read',
  table: products,
  id: products.id,
  label: products.name,
  searchColumns: [products.name, products.sku, products.stockCode],
  select: { sku: products.sku },
  scope: ({ filters }) => {
    const { at, ...rest } = filters;
    if (Object.keys(rest).length > 0) throw new LookupFilterError('Unsupported filter.');
    const conditions: SQL[] = [isNull(products.deletedAt)];
    if (at !== undefined) {
      if (!UUID.test(at)) throw new LookupFilterError('That is not a valid choice.');
      conditions.push(sql`EXISTS (SELECT 1 FROM stock_balances b WHERE b.product_id = ${products.id} AND b.location_id = ${at}::uuid AND b.on_hand > 0)`);
    }
    return [and(...conditions) ?? isNull(products.deletedAt)];
  },
  toOption: (row) => ({ id: text(row.id), label: text(row.label), description: text(row.sku) === '' ? null : text(row.sku), badge: null }),
});

const KIND_WORDS: Record<string, { label: string; hint: string }> = {
  warehouse: { label: 'Warehouse', hint: 'Stores stock and can supply orders' },
  store: { label: 'Shop or store', hint: 'Sells to customers and holds the stock on its shelves' },
  van: { label: 'Van or vehicle', hint: 'Stock a rider carries on a run' },
  quarantine: { label: 'Quarantine', hint: 'Held for inspection; never sold from' },
  damaged: { label: 'Damaged or scrap', hint: 'Not for sale' },
  consignment_in: { label: 'Consignment (held for a supplier)', hint: 'Stock that is not yet bought' },
};

/** The kinds of place a person can make. A transit place is made by the system for a transfer on its way. */
const kinds = staticSource({
  key: 'stock-location-kinds',
  permission: 'stock:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return LOCATION_KINDS.filter((k) => k !== 'transit').map((k) => ({ id: k, label: KIND_WORDS[k]?.label ?? k, description: KIND_WORDS[k]?.hint ?? null }));
  },
});

const transferStates = staticSource({
  key: 'stock-transfer-states',
  permission: 'stock:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return TRANSFER_STATES.map((s) => ({ id: s, label: TRANSFER_STATE_WORDS[s].label, description: null }));
  },
});

const countModes = staticSource({
  key: 'stock-count-modes',
  permission: 'stock:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return [
      { id: 'cycle', label: 'Cycle count: some products', description: 'Count the products you choose' },
      { id: 'full', label: 'Full count: everything the place holds', description: 'Lists every product with stock there' },
    ];
  },
});

const countStates = staticSource({
  key: 'stock-count-states',
  permission: 'stock:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return COUNT_STATES.map((s) => ({ id: s, label: COUNT_STATE_WORDS[s].label, description: null }));
  },
});

/** What to do with stock that did not arrive. */
const settlements = staticSource({
  key: 'stock-transfer-settlements',
  permission: 'stock:read',
  items: ({ filters }) => {
    acceptFilters(filters, {});
    return [
      { id: 'write_off', label: 'It is lost: write it off', description: 'The company owns less, and the books record the loss' },
      { id: 'return_to_source', label: 'Send it back to the sender', description: 'It returns to where it left from' },
    ];
  },
});

export const STOCK_LOOKUP_SOURCES: LookupSource[] = [locations, kinds, stockProducts, transferStates, countStates, countModes, settlements];
