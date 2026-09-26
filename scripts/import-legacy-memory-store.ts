/**
 * One-shot importer for the legacy in-memory store snapshot.
 *
 * Usage:
 *   npx tsx scripts/import-legacy-memory-store.ts .dev-exports/memory-store-<ts>.json
 *
 * The script is idempotent: every insert is an upsert keyed by the legacy id, so
 * re-running it against the same snapshot is safe. Foreign keys are resolved by
 * id first and by natural key (name/slug/code) second, which lets a snapshot that
 * predates the referential ids still land in the database.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { drizzleDb } from '../src/server/db/drizzle/client';
import {
  categories,
  currencies,
  inventoryMovements,
  itemTypes,
  paymentGatewayConfigs,
  paymentTransactions,
  products,
  reconciliationLogs,
  taxCategories,
  userSessions,
} from '../src/server/db/drizzle/schema';
import { encryptCredentials } from '../src/server/domains/payments/crypto';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Row = Record<string, any>;

function num(value: unknown, fallback = 0): string {
  const n = Number(value);
  return String(Number.isFinite(n) ? n : fallback);
}

function bool(value: unknown): boolean {
  return Boolean(value);
}

function date(value: unknown): Date {
  if (value instanceof Date) return value;
  const d = new Date(String(value ?? ''));
  return Number.isNaN(d.getTime()) ? new Date() : d;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function main() {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: tsx scripts/import-legacy-memory-store.ts <snapshot.json>');
    process.exit(1);
  }
  const snapshot: Row = JSON.parse(readFileSync(resolve(file), 'utf8'));
  const counts: Record<string, number> = {};

  // ---------------------------------------------------------------- categories
  const categoryIds = new Map<string, string>();
  for (const c of (snapshot.categories ?? []) as Row[]) {
    const name = String(c.name ?? 'Uncategorised');
    const slug = String(c.slug ?? slugify(name));
    const [row] = await drizzleDb
      .insert(categories)
      .values({
        id: c.id ?? `cat_${slug}`,
        name,
        slug,
        description: c.description ?? '',
        imageUrl: c.imageUrl ?? null,
        isActive: bool(c.isActive),
        displayOrder: Number(c.displayOrder ?? 0),
        createdAt: date(c.createdAt),
        updatedAt: date(c.updatedAt),
      })
      .onConflictDoUpdate({
        target: categories.id,
        set: { name, slug, description: c.description ?? '', updatedAt: new Date() },
      })
      .returning();
    categoryIds.set(String(c.id), row.id);
    categoryIds.set(name, row.id);
    counts.categories = (counts.categories ?? 0) + 1;
  }

  // ---------------------------------------------------------------- item types
  const itemTypeIds = new Map<string, string>();
  for (const t of (snapshot.itemTypes ?? []) as Row[]) {
    const name = String(t.name ?? 'Finished Products');
    const code = Number(t.code ?? 1);
    const [row] = await drizzleDb
      .insert(itemTypes)
      .values({
        id: t.id ?? `itype_${code}`,
        name,
        code,
        isSellable: bool(t.isSellable),
        isActive: bool(t.isActive ?? true),
        isDefault: bool(t.isDefault),
        createdAt: date(t.createdAt),
        updatedAt: date(t.updatedAt),
      })
      .onConflictDoUpdate({
        target: itemTypes.id,
        set: { name, code, isDefault: bool(t.isDefault), updatedAt: new Date() },
      })
      .returning();
    itemTypeIds.set(String(t.id), row.id);
    itemTypeIds.set(name.toLowerCase(), row.id);
    counts.itemTypes = (counts.itemTypes ?? 0) + 1;
  }
  // Fallback for products referencing an item type that was never registered.
  const fallbackItemTypeId = itemTypeIds.values().next().value as string | undefined;
  if (!fallbackItemTypeId) {
    throw new Error('snapshot contains no item types; cannot resolve products');
  }
  const defaultItemTypeId: string = fallbackItemTypeId;

  // ------------------------------------------------------------ tax categories
  const taxIds = new Map<string, string>();
  for (const t of (snapshot.taxCategories ?? []) as Row[]) {
    const name = String(t.name ?? 'VAT');
    // `code` is a text code in both the domain type and the table.
    const code = String(t.code ?? 'VAT');
    const [row] = await drizzleDb
      .insert(taxCategories)
      .values({
        id: t.id ?? `tax_${code}`,
        name,
        code,
        rate: num(t.rate ?? 0),
        type: t.type ?? 'percentage',
        countryCode: t.countryCode ?? 'KE',
        countryName: t.countryName ?? 'Kenya',
        description: t.description ?? '',
        isInclusive: bool(t.isInclusive),
        isDefault: bool(t.isDefault),
        isActive: bool(t.isActive ?? true),
        createdAt: date(t.createdAt),
        updatedAt: date(t.updatedAt),
      })
      .onConflictDoUpdate({
        target: taxCategories.id,
        set: { name, rate: num(t.rate ?? 0), updatedAt: new Date() },
      })
      .returning();
    taxIds.set(String(t.id), row.id);
    taxIds.set(name.toLowerCase(), row.id);
    counts.taxCategories = (counts.taxCategories ?? 0) + 1;
  }

  // ---------------------------------------------------------------- currencies
  for (const c of (snapshot.currencies ?? []) as Row[]) {
    const code = String(c.code ?? 'KES').toUpperCase();
    await drizzleDb
      .insert(currencies)
      .values({
        code,
        name: c.name ?? code,
        symbol: c.symbol ?? code,
        exchangeRate: num(c.exchangeRate ?? 1),
        isBaseCurrency: bool(c.isBaseCurrency),
        decimalDigits: Number(c.decimalDigits ?? 2),
        symbolPosition: c.symbolPosition ?? 'prefix',
        isEnabled: bool(c.isEnabled ?? true),
        flagEmoji: c.flagEmoji ?? null,
        updatedAt: date(c.updatedAt),
      })
      .onConflictDoUpdate({
        target: currencies.code,
        set: { name: c.name ?? code, exchangeRate: num(c.exchangeRate ?? 1), updatedAt: new Date() },
      });
    counts.currencies = (counts.currencies ?? 0) + 1;
  }

  // ------------------------------------------------------------------ products
  for (const p of (snapshot.products ?? []) as Row[]) {
    const name = String(p.name ?? 'Untitled');
    const categoryName = String(p.category ?? '');
    const categoryId = categoryIds.get(categoryName) ?? null;
    const itemTypeId =
      itemTypeIds.get(String(p.itemTypeId)) ??
      itemTypeIds.get(String(p.itemTypeName ?? '').toLowerCase()) ?? defaultItemTypeId;
    const taxCategoryId =
      taxIds.get(String(p.taxCategoryId)) ??
      taxIds.get(String(p.taxCategoryName ?? '').toLowerCase()) ??
      null;

    const productValues = {
        id: p.id ?? `prod_${slugify(name)}_${Date.now()}`,
        sku: p.sku ?? `SKU-${slugify(name).toUpperCase()}`,
        name,
        slug: p.slug ?? slugify(name),
        description: p.description ?? '',
        categoryId,
        categoryName,
        brand: p.brand ?? null,
        itemTypeId,
        tags: p.tags ?? [],
        specifications: p.specifications ?? [],
        imageUrl: p.imageUrl ?? '',
        isSellable: bool(p.isSellable ?? true),
        isActive: bool(p.isActive ?? true),
        price: num(p.price ?? 0),
        compareAtPrice: p.compareAtPrice == null ? null : num(p.compareAtPrice),
        costPrice: num(p.costPrice ?? 0),
        taxCategoryId,
        taxRate: p.taxRate == null ? null : num(p.taxRate),
        isTaxInclusive: bool(p.isTaxInclusive),
        stockQuantity: Number(p.stockQuantity ?? 0),
        reservedQuantity: Number(p.reservedQuantity ?? 0),
        lowStockThreshold: Number(p.lowStockThreshold ?? 0),
        weight: p.weight == null ? null : num(p.weight),
        createdAt: date(p.createdAt),
        updatedAt: date(p.updatedAt),
      } satisfies typeof products.$inferInsert;
    await drizzleDb
      .insert(products)
      .values(productValues)
      .onConflictDoUpdate({
        target: products.id,
        set: {
          name,
          sku: p.sku,
          price: num(p.price ?? 0),
          stockQuantity: Number(p.stockQuantity ?? 0),
          reservedQuantity: Number(p.reservedQuantity ?? 0),
          categoryId,
          itemTypeId,
          taxCategoryId,
          updatedAt: new Date(),
        },
      });
    counts.products = (counts.products ?? 0) + 1;
  }

  // --------------------------------------------------------- inventory movements
  for (const m of (snapshot.inventoryLedger ?? []) as Row[]) {
    await drizzleDb
      .insert(inventoryMovements)
      .values({
        id: m.id ?? `mv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        productId: m.productId,
        productName: m.productName ?? '',
        changeType: m.changeType ?? 'manual_adjustment',
        changeAmount: Number(m.changeAmount ?? 0),
        previousStock: Number(m.previousStock ?? 0),
        newStock: Number(m.newStock ?? 0),
        referenceId: m.referenceId ?? '',
        actor: m.actor ?? 'legacy_import',
        note: m.note ?? '',
        createdAt: date(m.timestamp ?? m.createdAt),
      })
      .onConflictDoNothing();
    counts.inventoryMovements = (counts.inventoryMovements ?? 0) + 1;
  }

  // --------------------------------------------------------- payment gateways
  for (const g of (snapshot.paymentGateways ?? []) as Row[]) {
    const creds = (g.credentials ?? {}) as Record<string, unknown>;
    await drizzleDb
      .insert(paymentGatewayConfigs)
      .values({
        id: g.id,
        provider: g.provider ?? g.id,
        name: g.name ?? g.id,
        isEnabled: bool(g.isEnabled),
        environment: g.environment ?? 'sandbox',
        // The export redacts secrets, so an empty blob is correct here rather
        // than seeding a literal "REDACTED" placeholder.
        credentialsEncrypted:
          creds && Object.keys(creds).length > 0 ? encryptCredentials(creds) : null,
        supportedCurrencies: g.supportedCurrencies ?? [],
        icon: g.icon ?? '',
        description: g.description ?? '',
        updatedAt: date(g.updatedAt),
      })
      .onConflictDoUpdate({
        target: paymentGatewayConfigs.id,
        set: { isEnabled: bool(g.isEnabled), updatedAt: new Date() },
      });
    counts.paymentGatewayConfigs = (counts.paymentGatewayConfigs ?? 0) + 1;
  }

  // ------------------------------------------------------------- transactions
  for (const t of (snapshot.transactions ?? []) as Row[]) {
    await drizzleDb
      .insert(paymentTransactions)
      .values({
        id: t.id,
        orderId: t.orderId,
        orderNumber: t.orderNumber ?? '',
        gatewayProvider: t.gatewayProvider ?? 'mpesa_daraja',
        transactionReference: t.transactionReference,
        externalReference: t.externalReference ?? null,
        amount: num(t.amount),
        currency: t.currency ?? 'KES',
        status: t.status ?? 'pending',
        customerPhone: t.customerPhone ?? null,
        customerEmail: t.customerEmail ?? null,
        requestPayload: t.requestPayload ?? {},
        responsePayload: t.responsePayload ?? {},
        ipnStatus: t.ipnStatus ?? 'pending',
        reconciliationStatus: t.reconciliationStatus ?? 'pending',
        errorMessage: t.errorMessage ?? null,
        createdAt: date(t.createdAt),
        updatedAt: date(t.updatedAt),
      })
      .onConflictDoNothing();
    counts.paymentTransactions = (counts.paymentTransactions ?? 0) + 1;
  }

  // -------------------------------------------------------- reconciliation logs
  for (const l of (snapshot.reconciliationLogs ?? []) as Row[]) {
    await drizzleDb
      .insert(reconciliationLogs)
      .values({
        id: l.id,
        transactionId: l.transactionId ?? 'unlinked',
        orderId: l.orderId,
        orderNumber: l.orderNumber ?? '',
        provider: l.provider ?? 'unknown',
        reconciliationType: l.reconciliationType ?? 'manual_override',
        orderTotal: num(l.orderTotal),
        receivedAmount: num(l.receivedAmount),
        discrepancyFound: bool(l.discrepancyFound),
        discrepancyType: l.discrepancyType ?? 'none',
        status: l.status ?? 'matched',
        details: l.details ?? '',
        createdAt: date(l.timestamp ?? l.createdAt),
      })
      .onConflictDoNothing();
    counts.reconciliationLogs = (counts.reconciliationLogs ?? 0) + 1;
  }

  // -------------------------------------------------------------- user sessions
  for (const s of (snapshot.userSessions ?? []) as Row[]) {
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(String(s.token ?? '')).digest('hex');
    await drizzleDb
      .insert(userSessions)
      .values({
        id: `sess_${tokenHash.slice(0, 16)}`,
        tokenHash,
        userId: s.userId ?? 'unknown',
        email: s.email ?? '',
        name: s.name ?? '',
        role: s.role ?? 'customer',
        createdAt: date(s.createdAt),
      })
      .onConflictDoNothing();
    counts.userSessions = (counts.userSessions ?? 0) + 1;
  }

  // ------------------------------------------------------------------- report
  console.log('imported:', counts);
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
