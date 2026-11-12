import { and, eq, isNull } from 'drizzle-orm';
import { products } from '@/server/db/drizzle/schema';
import { PACKAGE_PRICING_CHOICES, PACKAGE_SHORT_STOCK_CHOICES, PACKAGE_SPLIT_CHOICES, type PackageChoice } from '@/lib/package-choices';
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

export const PRICING_LOOKUP_SOURCES: LookupSource[] = [
  fixed('package-pricing-modes', PACKAGE_PRICING_CHOICES),
  fixed('package-short-stock-modes', PACKAGE_SHORT_STOCK_CHOICES),
  fixed('package-split-methods', PACKAGE_SPLIT_CHOICES),
  packageProducts,
  packageOptionProducts,
];
