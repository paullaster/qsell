import { decryptCredentials } from '@/server/domains/payments/crypto';
import type {
  Category,
  CurrencyConfig,
  InventoryLedgerEntry,
  ItemType,
  PaymentGatewayConfig,
  Product,
  PublicProduct,
  ReconciliationLog,
  TaxCategory,
  TransactionRecord,
} from '@/types/index';
import type {
  CategoryRow,
  CurrencyRow,
  InventoryMovementRow,
  ItemTypeRow,
  PaymentGatewayConfigRow,
  PaymentTransactionRow,
  ProductInsert,
  ReconciliationLogRow,
  TaxCategoryRow,
} from '@/server/db/drizzle/schema';
import type { ProductJoined } from './repository';

/**
 * Row → domain mappers.
 *
 * Postgres `numeric` columns come back as strings and `jsonb` may be null, so
 * every mapper normalises explicitly. Keeping this in one file means the rest
 * of the app keeps working against the domain types in `src/types/index.ts` and
 * never has to know the storage shape changed.
 */

/** `numeric` arrives as a string; empty/absent becomes the fallback. */
function num(value: string | number | null | undefined, fallback = 0): number {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function optionalNum(value: string | number | null | undefined): number | undefined {
  if (value === null || value === undefined) return undefined;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function iso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function toCategory(row: CategoryRow, productCount?: number): Category {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    imageUrl: row.imageUrl ?? undefined,
    isActive: row.isActive,
    displayOrder: row.displayOrder,
    productCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toItemType(row: ItemTypeRow, productCount?: number): ItemType {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    isSellable: row.isSellable,
    isDefault: row.isDefault,
    isActive: row.isActive,
    productCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toTaxCategory(row: TaxCategoryRow, productCount?: number): TaxCategory {
  return {
    id: row.id,
    name: row.name,
    code: row.code,
    rate: num(row.rate),
    timsCode: row.timsCode,
    etimsCode: row.etimsCode,
    type: row.type as TaxCategory['type'],
    countryCode: row.countryCode,
    countryName: row.countryName,
    description: row.description,
    isInclusive: row.isInclusive,
    isDefault: row.isDefault,
    isActive: row.isActive,
    productCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toCurrency(row: CurrencyRow): CurrencyConfig {
  return {
    code: row.code,
    name: row.name,
    symbol: row.symbol,
    exchangeRate: num(row.exchangeRate, 1),
    isBaseCurrency: row.isBaseCurrency,
    decimalDigits: row.decimalDigits,
    symbolPosition: row.symbolPosition as CurrencyConfig['symbolPosition'],
    isEnabled: row.isEnabled,
    flagEmoji: row.flagEmoji ?? undefined,
    updatedAt: iso(row.updatedAt),
  };
}

export function toProduct(row: ProductJoined): Product {
  return {
    id: row.id,
    sku: row.sku,
    stockCode: row.stockCode,
    name: row.name,
    slug: row.slug,
    description: row.description,
    // Prefer the live category name, fall back to the stored display name so
    // products whose category was deleted still render correctly.
    category: row.categoryLabel ?? row.categoryName,
    brand: row.brand ?? undefined,
    itemTypeId: row.itemTypeId,
    // Defensive: the FK guarantees a match, but a null here would be a data
    // integrity failure worth surfacing rather than rendering as "undefined".
    itemTypeName: row.itemTypeName ?? 'Unknown item type',
    itemTypeCode: row.itemTypeCode ?? 0,
    isSellable: row.isSellable,
    price: optionalNum(row.price),
    compareAtPrice: optionalNum(row.compareAtPrice),
    costPrice: num(row.costPrice),
    taxCategoryId: row.taxCategoryId ?? undefined,
    taxCategoryName: row.taxCategoryName ?? undefined,
    taxRate: optionalNum(row.taxRate),
    isTaxInclusive: row.isTaxInclusive ?? undefined,
    weight: optionalNum(row.weight),
    specifications: row.specifications ?? [],
    stockQuantity: row.stockQuantity,
    reservedQuantity: row.reservedQuantity,
    lowStockThreshold: row.lowStockThreshold,
    isActive: row.isActive,
    imageUrl: row.imageUrl,
    additionalImages: row.additionalImages ?? [],
    rating: num(row.rating),
    reviewCount: row.reviewCount,
    tags: row.tags ?? [],
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** Strips staff-only fields (unit cost) before a product leaves the server for the storefront. */
export function toPublicProduct(product: Product): PublicProduct {
  const publicProduct: Partial<Product> = { ...product };
  delete publicProduct.costPrice;
  return publicProduct as PublicProduct;
}

export function toLedgerEntry(row: InventoryMovementRow): InventoryLedgerEntry {
  return {
    id: row.id,
    productId: row.productId,
    productName: row.productName,
    changeAmount: row.changeAmount,
    previousStock: row.previousStock,
    newStock: row.newStock,
    changeType: row.changeType as InventoryLedgerEntry['changeType'],
    referenceId: row.referenceId,
    actor: row.actor,
    note: row.note,
    timestamp: iso(row.createdAt),
  };
}

export function toGatewayConfig(row: PaymentGatewayConfigRow): PaymentGatewayConfig {
  return {
    id: row.id,
    provider: row.provider as PaymentGatewayConfig['provider'],
    name: row.name,
    isEnabled: row.isEnabled,
    environment: row.environment as PaymentGatewayConfig['environment'],
    credentials: decryptCredentials(row.credentialsEncrypted) ?? {},
    supportedCurrencies: row.supportedCurrencies ?? [],
    icon: row.icon,
    description: row.description,
  };
}

export function toTransaction(row: PaymentTransactionRow): TransactionRecord {
  return {
    id: row.id,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    gatewayProvider: row.gatewayProvider as TransactionRecord['gatewayProvider'],
    transactionReference: row.transactionReference,
    externalReference: row.externalReference ?? undefined,
    amount: num(row.amount),
    currency: row.currency,
    status: row.status as TransactionRecord['status'],
    customerPhone: row.customerPhone ?? undefined,
    customerEmail: row.customerEmail ?? undefined,
    requestPayload: row.requestPayload ?? {},
    responsePayload: row.responsePayload ?? {},
    ipnStatus: row.ipnStatus as TransactionRecord['ipnStatus'],
    reconciliationStatus:
      row.reconciliationStatus as TransactionRecord['reconciliationStatus'],
    errorMessage: row.errorMessage ?? undefined,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

export function toReconciliationLog(row: ReconciliationLogRow): ReconciliationLog {
  return {
    id: row.id,
    transactionId: row.transactionId,
    orderId: row.orderId,
    orderNumber: row.orderNumber,
    provider: row.provider as ReconciliationLog['provider'],
    reconciliationType:
      row.reconciliationType as ReconciliationLog['reconciliationType'],
    orderTotal: num(row.orderTotal),
    receivedAmount: num(row.receivedAmount),
    discrepancyFound: row.discrepancyFound,
    discrepancyType:
      row.discrepancyType as ReconciliationLog['discrepancyType'] | undefined,
    status: row.status as ReconciliationLog['status'],
    details: row.details,
    timestamp: iso(row.createdAt),
  };
}

/** Product insert values from a domain object, with numerics stringified. */
export function productToRow(product: Product): ProductInsert {
  return {
    id: product.id,
    sku: product.sku,
    stockCode: product.stockCode,
    name: product.name,
    slug: product.slug,
    description: product.description,
    categoryId: null,
    categoryName: product.category,
    brand: product.brand ?? null,
    itemTypeId: product.itemTypeId,
    isSellable: product.isSellable,
    price: product.price == null ? null : String(product.price),
    compareAtPrice: product.compareAtPrice == null ? null : String(product.compareAtPrice),
    costPrice: String(product.costPrice),
    taxCategoryId: product.taxCategoryId ?? null,
    taxRate: product.taxRate == null ? null : String(product.taxRate),
    isTaxInclusive: product.isTaxInclusive ?? null,
    weight: product.weight == null ? null : String(product.weight),
    specifications: product.specifications ?? [],
    stockQuantity: product.stockQuantity,
    reservedQuantity: product.reservedQuantity,
    lowStockThreshold: product.lowStockThreshold,
    isActive: product.isActive,
    imageUrl: product.imageUrl,
    additionalImages: product.additionalImages ?? [],
    rating: String(product.rating),
    reviewCount: product.reviewCount,
    tags: product.tags ?? [],
    createdAt: new Date(product.createdAt),
    updatedAt: new Date(product.updatedAt),
  };
}
