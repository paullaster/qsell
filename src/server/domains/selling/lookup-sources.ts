import { and, eq, isNull, sql } from 'drizzle-orm';
import { customers, products } from '@/server/db/drizzle/schema';
import { acceptFilters, LookupFilterError, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';
import { methodLabel } from '@/lib/payment-method-labels';
import { SALES_ORDER_PAYMENT_METHODS } from './domain/sales-order-input';
import { allowedOptions, ENUM_SETTINGS, isSellingType, OPTION_WORDS, SELLING_TYPES, type EnumSetting } from './selling-documents';

const isEnum = (value: string): value is EnumSetting => (ENUM_SETTINGS as readonly string[]).includes(value);

/** The choices of one setting for one selling document type (`setting` and `type` filters), as the settings screen's pickers list them. */
const options = staticSource({
  key: 'selling-setting-options',
  permission: 'selling_settings:manage',
  items: ({ filters }) => {
    const { setting, type } = acceptFilters(filters, { setting: ENUM_SETTINGS, type: SELLING_TYPES });
    if (setting === undefined || !isEnum(setting) || type === undefined || !isSellingType(type)) throw new LookupFilterError('Unsupported filter.');
    return allowedOptions(type, setting).map((id) => ({ id, label: OPTION_WORDS[setting][id]?.label ?? id, description: OPTION_WORDS[setting][id]?.description ?? null, badge: null }));
  },
});

/** Products a sales order can sell as lines of their own: for sale, switched on, not kept for packages, and not a package (those are chosen with their builder). */
const salesOrderProducts = tableSource({
  key: 'sales-order-products',
  permission: 'sales_orders:create',
  table: products,
  id: products.id,
  label: products.name,
  searchColumns: [products.name, products.sku, products.stockCode],
  select: { sku: products.sku, price: products.price },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [
      and(
        eq(products.isActive, true),
        eq(products.isSellable, true),
        isNull(products.deletedAt),
        eq(products.soldOnlyInPackages, false),
        sql`${products.id} NOT IN (SELECT product_id FROM product_packages WHERE is_active)`,
      ) ?? eq(products.isActive, true),
    ];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: `${String(row.sku)} · ${String(row.price)}`, badge: null, meta: { price: String(row.price) } }),
});

/** The packages a sales order can sell, for staff who may take sales orders. */
const salesOrderPackages = tableSource({
  key: 'sales-order-packages',
  permission: 'sales_orders:create',
  table: products,
  id: products.id,
  label: products.name,
  searchColumns: [products.name, products.sku],
  select: { sku: products.sku },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [and(eq(products.isActive, true), eq(products.isSellable, true), isNull(products.deletedAt), sql`${products.id} IN (SELECT product_id FROM product_packages WHERE is_active)`) ?? eq(products.isActive, true)];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: String(row.sku), badge: null }),
});

/** The customers a sales order can be taken for (staff who may take sales orders, not only those who may read the customer master). */
const salesOrderCustomers = tableSource({
  key: 'sales-order-customers',
  permission: 'sales_orders:create',
  table: customers,
  id: customers.id,
  label: customers.name,
  searchColumns: [customers.name, customers.number, customers.email, customers.phone],
  select: { number: customers.number, email: customers.email, accountType: customers.accountType },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(customers.companyId, companyId), eq(customers.isActive, true)];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: [row.number, row.email].filter((x): x is string => typeof x === 'string' && x !== '').join(' · '), badge: row.accountType === 'credit' ? 'Credit' : null }),
});

/** How a sales order's customer is expected to pay. */
const salesOrderPaymentMethods = staticSource({
  key: 'sales-order-payment-methods',
  permission: 'sales_orders:create',
  items: () => SALES_ORDER_PAYMENT_METHODS.map((id) => ({ id, label: methodLabel(id), description: null, badge: null })),
});

export const SELLING_LOOKUP_SOURCES: LookupSource[] = [options, salesOrderProducts, salesOrderPackages, salesOrderCustomers, salesOrderPaymentMethods];
