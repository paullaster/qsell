import { and, eq, inArray } from 'drizzle-orm';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { productPackages, products as productsTable } from '@/server/db/drizzle/schema';
import { isInventoryManaged } from '@/lib/inventory-kind';
import { roundQty } from '@/lib/decimal';
import { kitTax, type Kit } from '@/server/domains/pricing/kit-service';
import type { PublicProduct } from '@/types/index';

/**
 * What the shop may sell of each product. While the per-location ledger is the truth, a product's own two counters add up every
 * location, including a quarantine, a van on the road or a place that does not sell to the web shop; the shop would offer stock it
 * cannot sell. So the shop is told the stock of the places that do sell to it, in the same two numbers it already reads
 * (on hand and promised), and nothing else in the shop changes. Without the ledger the counters are the truth and nothing is touched.
 * Design: docs/architecture/stock-locations.md §6.1 and §9.
 */
export async function withShopAvailability(products: PublicProduct[]): Promise<PublicProduct[]> {
  if (products.length === 0) return products;
  try {
    return await withPackageFlag(await withKitAvailability(await withLedgerAvailability(products)));
  } catch (error) {
    console.error('[shop] availability', error);
    return products;
  }
}

async function withLedgerAvailability(products: PublicProduct[]): Promise<PublicProduct[]> {
  const container = getContainer();
  if (!(await container.stockSettings.isLedgerMode())) return products;
  const found = await container.stockAvailability.forProducts(products.map((p) => p.id), 'ecommerce');
  return products.map((p) => {
    const a = found.get(p.id);
    return a === undefined ? p : { ...p, stockQuantity: a.onHand, reservedQuantity: a.reserved };
  });
}

/** How many of a kit the stock of its parts can make: the scarcest part decides. A part that is not counted never limits it. */
export function kitsBuildable(kit: { components: Pick<Kit['components'][number], 'productId' | 'quantity' | 'unavailable'>[] }, parts: ReadonlyMap<string, { stock: number; reserved: number; managed: boolean }>): number {
  let most = Number.POSITIVE_INFINITY;
  // A part that is switched off or deleted cannot be sold, so neither can the kit.
  if (kit.components.some((c) => c.unavailable)) return 0;
  for (const c of kit.components) {
    const part = parts.get(c.productId);
    if (part === undefined || c.quantity <= 0) return 0;
    if (!part.managed) continue;
    most = Math.min(most, Math.floor(roundQty(Math.max(0, part.stock - part.reserved) / c.quantity)));
  }
  return Number.isFinite(most) ? most : Number.POSITIVE_INFINITY;
}

/**
 * A kit has no stock of its own: it is made from its parts when sold. So the shop is shown how many can be made from the parts'
 * stock in place of the kit product's own counters, and the kit counts as stock-managed, so "sold out" and the cart limit follow
 * the parts. The sale itself still checks each part at checkout.
 */
async function withKitAvailability(products: PublicProduct[]): Promise<PublicProduct[]> {
  const container = getContainer();
  const company = await container.companySettings.ensureSeeded();
  const kits = await container.kits.forProducts(company.id, products.map((p) => p.id));
  if (kits.size === 0) return products;
  const partIds = [...new Set([...kits.values()].flatMap((k) => k.components.map((c) => c.productId)))];
  const rows = await drizzleDb
    .select({ id: productsTable.id, stock: productsTable.stockQuantity, reserved: productsTable.reservedQuantity, kind: productsTable.inventoryKind })
    .from(productsTable)
    .where(inArray(productsTable.id, partIds));
  const parts = new Map(rows.map((r) => [r.id, { stock: r.stock, reserved: r.reserved, managed: isInventoryManaged({ inventoryKind: r.kind }) }]));
  // In ledger mode the parts are counted where the web shop sells from, like any other product.
  if (await container.stockSettings.isLedgerMode()) {
    const found = await container.stockAvailability.forProducts(partIds, 'ecommerce');
    for (const [id, a] of found) {
      const part = parts.get(id);
      if (part !== undefined) parts.set(id, { ...part, stock: a.onHand, reserved: a.reserved });
    }
  }
  return products.map((p) => {
    const kit = kits.get(p.id);
    if (kit === undefined) return p;
    const made = kitsBuildable(kit, parts);
    // The shop works out tax on the product it shows, but the order taxes a kit part by part. So the kit is shown at the one rate
    // that comes to the same tax: the shares of the price are fixed fractions, so this holds at any price and quantity (a price that comes only from a price list included).
    const priced = kitTax(100, 1, kit, p.isTaxInclusive !== false);
    const taxRate = priced.net <= 0 ? p.taxRate : Math.round((priced.tax / priced.net) * 100_000) / 1000;
    const shown = { ...p, ...(taxRate === undefined ? {} : { taxRate }) };
    // Parts nobody counts never run out, so neither does the kit.
    return Number.isFinite(made) ? { ...shown, inventoryKind: 'inventory', stockQuantity: made, reservedQuantity: 0 } : { ...shown, inventoryKind: 'non_inventory' };
  });
}

/**
 * A configurable package has no stock of its own: it is made of the options a shopper picks. So it is flagged (the shop sends the
 * shopper to the builder instead of adding it as it stands) and counted as not stock-managed; each option's stock is checked when
 * the shopper builds it. Only packages that are switched on are flagged.
 */
async function withPackageFlag(products: PublicProduct[]): Promise<PublicProduct[]> {
  const rows = await drizzleDb
    .select({ productId: productPackages.productId })
    .from(productPackages)
    .where(and(inArray(productPackages.productId, products.map((p) => p.id)), eq(productPackages.isActive, true)));
  if (rows.length === 0) return products;
  const container = getContainer();
  // The shop shows the "from" price, the price of the cheapest choice that can be made (it also feeds the page's structured data and share card).
  const views = await container.packageConfig.list((await container.companySettings.ensureSeeded()).id, rows.map((r) => r.productId));
  const from = new Map(views.map((v) => [v.productId, v.from.price]));
  return products.map((p) => {
    if (!from.has(p.id)) return p;
    const price = from.get(p.id);
    return { ...p, isPackage: true, inventoryKind: 'non_inventory', ...(price === null || price === undefined ? {} : { price }) };
  });
}
