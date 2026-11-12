import { and, eq, isNull, sql } from 'drizzle-orm';
import { customerGroups, products } from '@/server/db/drizzle/schema';
import { PACKAGE_AUDIENCE_CHOICES, PACKAGE_PRICING_CHOICES, PACKAGE_SHORT_STOCK_CHOICES, PACKAGE_SPLIT_CHOICES, type PackageChoice } from '@/lib/package-choices';
import { acceptFilters, staticSource, tableSource, type LookupSource } from '@/server/domains/lookups/runner';

const fixed = (key: string, choices: readonly PackageChoice[]): LookupSource =>
  staticSource({
    key,
    permission: 'pricing:read',
    items: ({ filters }) => {
      acceptFilters(filters, {});
      return choices.map((c) => ({ ...c, description: null }));
    },
  });

const sellable = [eq(products.isActive, true), eq(products.isSellable, true), eq(products.isCheckoutPackaging, false), isNull(products.deletedAt)] as const;

/** Products that can be made into a package: sold on their own, not themselves a part that only packages sell. */
const packageProducts = tableSource({
  key: 'package-products',
  permission: 'pricing:read',
  table: products,
  id: products.id,
  label: products.name,
  searchColumns: [products.name, products.sku, products.stockCode],
  select: { sku: products.sku },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [and(...sellable, eq(products.soldOnlyInPackages, false)) ?? eq(products.isActive, true)];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: String(row.sku), badge: null }),
});

/** Products a package can offer as an option: anything that can be sold, parts that only packages sell included. */
const packageOptionProducts = tableSource({
  key: 'package-option-products',
  permission: 'pricing:read',
  table: products,
  id: products.id,
  label: products.name,
  searchColumns: [products.name, products.sku, products.stockCode],
  select: { sku: products.sku, onlyInPackages: products.soldOnlyInPackages },
  scope: ({ filters }) => {
    acceptFilters(filters, {});
    return [and(...sellable) ?? eq(products.isActive, true)];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: String(row.sku), badge: row.onlyInPackages === true ? 'Packages only' : null }),
});

/** The packages a quote can sell (staff with quote access, not only those who set packages up). */
const quotePackages = tableSource({
  key: 'quote-packages',
  permission: 'quotes:read',
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

/** The customer groups a package can be limited to. */
const packageCustomerGroups = tableSource({
  key: 'package-customer-groups',
  permission: 'pricing:read',
  table: customerGroups,
  id: customerGroups.id,
  label: customerGroups.name,
  searchColumns: [customerGroups.name, customerGroups.code],
  select: { code: customerGroups.code },
  scope: ({ filters, companyId }) => {
    acceptFilters(filters, {});
    return [eq(customerGroups.companyId, companyId)];
  },
  toOption: (row) => ({ id: String(row.id), label: String(row.label), description: String(row.code), badge: null }),
});

export const PRICING_LOOKUP_SOURCES: LookupSource[] = [
  fixed('package-pricing-modes', PACKAGE_PRICING_CHOICES),
  fixed('package-short-stock-modes', PACKAGE_SHORT_STOCK_CHOICES),
  fixed('package-split-methods', PACKAGE_SPLIT_CHOICES),
  fixed('package-audiences', PACKAGE_AUDIENCE_CHOICES),
  packageCustomerGroups,
  quotePackages,
  packageProducts,
  packageOptionProducts,
];
