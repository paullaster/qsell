import { and, eq, isNull, sql } from 'drizzle-orm';
import type { PermissionKey } from '@/server/domains/access-control/permissions';
import { customers, orders, paymentMethods, products } from '@/server/db/drizzle/schema';
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

/**
 * The pickers a selling screen uses (customers, products, packages, how they will pay), one set for each kind of document, each behind
 * the permission of taking that document: `sales-order-*` for sales orders, `sales-invoice-*` for direct sales invoices and `credit-sale-*`
 * for credit sales (whose customers are only those with a credit account).
 */
function pickers(prefix: 'sales-order' | 'sales-invoice' | 'credit-sale' | 'cash-sale', permission: PermissionKey): LookupSource[] {
  /** Products sold as lines of their own: for sale, switched on, not kept for packages, and not a package (those are chosen with their builder). */
  const productList = tableSource({
    key: `${prefix}-products`,
    permission,
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
  const packageList = tableSource({
    key: `${prefix}-packages`,
    permission,
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
  const customerList = tableSource({
    key: `${prefix}-customers`,
    permission,
    table: customers,
    id: customers.id,
    label: customers.name,
    searchColumns: [customers.name, customers.number, customers.email, customers.phone],
    select: { number: customers.number, email: customers.email, accountType: customers.accountType },
    scope: ({ companyId, filters }) => {
      acceptFilters(filters, {});
      return [eq(customers.companyId, companyId), eq(customers.isActive, true), ...(prefix === 'credit-sale' ? [eq(customers.accountType, 'credit')] : []), ...(prefix === 'cash-sale' ? [eq(customers.isWalkIn, false)] : [])];
    },
    toOption: (row) => ({ id: String(row.id), label: String(row.label), description: [row.number, row.email].filter((x): x is string => typeof x === 'string' && x !== '').join(' · '), badge: row.accountType === 'credit' ? 'Credit' : null }),
  });
  const paymentList = staticSource({
    key: `${prefix}-payment-methods`,
    permission,
    items: () => SALES_ORDER_PAYMENT_METHODS.map((id) => ({ id, label: methodLabel(id), description: null, badge: null })),
  });
  return [productList, packageList, customerList, paymentList];
}

/** Orders a tax invoice can still be raised for: none yet, not waiting for or refused by approval, not cancelled or failed. */
const invoiceableOrders = tableSource({
  key: 'invoiceable-orders',
  permission: 'sales_invoices:create',
  table: orders,
  id: orders.id,
  label: orders.orderNumber,
  searchColumns: [orders.orderNumber, orders.customerName],
  select: { customer: orders.customerName, total: orders.totalAmount, currency: orders.currency },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [
      sql`NOT EXISTS (SELECT 1 FROM invoice_documents d WHERE d.order_id = ${orders.id} AND d.document_type = 'tax_invoice')`,
      sql`${orders.approvalStatus} NOT IN ('pending', 'rejected', 'draft')`,
      sql`${orders.status} NOT IN ('cancelled', 'failed')`,
    ];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: `${String(row.customer)} · ${String(row.currency)} ${String(row.total)}`, badge: null }),
});

const COUNTER_KIND_WORDS: Record<string, string> = { cash: 'Cash', card: 'Card', mobile_money: 'M-Pesa or mobile money' };

/**
 * The ways of paying a counter sale: cash, M-Pesa and card methods that are switched on, pay into a real cash or bank account and can take customer
 * money. Which of them this till may use (its branch) is decided again when the sale is completed.
 */
const counterMethods = tableSource({
  key: 'counter-methods',
  permission: 'cash_sales:create',
  table: paymentMethods,
  id: paymentMethods.id,
  label: paymentMethods.name,
  searchColumns: [paymentMethods.name, paymentMethods.code],
  select: { kind: paymentMethods.kind, requiresReference: paymentMethods.requiresReference },
  scope: ({ companyId, filters }) => {
    acceptFilters(filters, {});
    return [eq(paymentMethods.companyId, companyId), eq(paymentMethods.enabled, true), sql`${paymentMethods.kind} IN ('cash', 'mobile_money', 'card')`, sql`${paymentMethods.balancingBankAccountId} IS NOT NULL`, sql`${paymentMethods.usableFor} @> '["customer_receipt"]'::jsonb`];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: COUNTER_KIND_WORDS[String(row.kind)] ?? null, badge: null, meta: { kind: String(row.kind), requiresReference: row.requiresReference === true ? 'yes' : 'no' } }),
});

export const SELLING_LOOKUP_SOURCES: LookupSource[] = [options, counterMethods, ...pickers('sales-order', 'sales_orders:create'), ...pickers('sales-invoice', 'sales_invoices:create'), ...pickers('cash-sale', 'cash_sales:create'), ...pickers('credit-sale', 'credit_sales:create'), invoiceableOrders];
