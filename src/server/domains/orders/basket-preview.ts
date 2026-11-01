import { inArray } from 'drizzle-orm';
import { computeCheckoutTotals } from '@/lib/checkoutPricing';
import { priceItemFor } from '@/server/domains/pricing/service';
import { expandKits } from '@/server/domains/pricing/kit-service';
import { CatalogService } from '@/server/domains/catalog/service';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { products as productsTable } from '@/server/db/drizzle/schema';
import { firstFilled, nth, orElse } from '@/lib/values';
import { lineAmounts } from './write-service';

export type BasketPreview =
  | {
      ok: true;
      subtotal: number;
      tax: number;
      /** Subtotal plus tax: the value the order-value discounts on delivery are read against. */
      goodsTotal: number;
      weightKg: number;
      /** What leaves the shelves, with kits broken into their parts. */
      stockLines: { productId: string; quantity: number }[];
      currency: 'KES';
    }
  | { ok: false; error: string };

/**
 * What a shop basket comes to, priced the way the shop prices an order (the same price lists, for the same customer, at the same
 * branch), so the value and the weight a delivery charge is worked from are the ones the order will have. The order is the
 * authority; if anything here differs, the order's own charge differs and the shopper is told before paying.
 */
export async function previewShopBasket(items: readonly { productId: string; quantity: number }[], customerId: string | null): Promise<BasketPreview> {
  const { companySettings, organizations, branches, pricing, kits } = getContainer();
  const company = await companySettings.ensureSeeded();
  const { branch } = await organizations.ensureDefaultOrgAndBranch(company.id, orElse(firstFilled(company.tradingName, company.legalName), 'Company'));
  const sellingBranch = (await branches.getDefault(company.id)) ?? branch;
  const found = new Map((await CatalogService.getProductsByIds(items.map((i) => i.productId))).map((p) => [p.id, p]));

  const sellable = items.filter((i) => found.get(i.productId)?.isSellable === true);
  if (sellable.length !== items.length || sellable.length === 0) return { ok: false, error: 'Something in your basket is no longer for sale. Please look at your basket again.' };
  const priced = await pricing.priceLines(
    company.id,
    { customerId, branchId: sellingBranch.id, salesType: 'cash', channel: 'ecommerce' },
    sellable.map((i) => {
      const product = found.get(i.productId);
      if (product === undefined) throw new Error('product vanished');
      return priceItemFor(product, i.quantity);
    }),
  );

  const lines = sellable.map((item, n) => {
    const product = nth([...found.values()].filter((p) => p.id === item.productId), 0);
    const result = priced[n];
    if (result?.unitPrice == null && (product.price == null || !Number.isFinite(product.price) || product.price <= 0)) return null;
    const { unitPrice, total } = lineAmounts(undefined, result, product.price, item.quantity);
    return { item, product, unitPrice, total };
  });
  if (lines.some((l) => l === null)) return { ok: false, error: 'Something in your basket cannot be priced right now.' };
  const priceable = lines.flatMap((l) => (l === null ? [] : [l]));

  const kitDefs = await kits.forProducts(company.id, priceable.map((l) => l.item.productId));
  let stock = priceable.map((l) => ({ productId: l.item.productId, quantity: l.item.quantity }));
  if (kitDefs.size > 0) {
    try {
      stock = expandKits(
        priceable.map((l) => ({ productId: l.item.productId, productName: l.product.name, sku: l.product.sku, quantity: l.item.quantity, unitPrice: l.unitPrice, totalPrice: l.total, imageUrl: l.product.imageUrl, taxRate: l.product.taxRate ?? 0, isTaxInclusive: l.product.isTaxInclusive !== false })),
        kitDefs,
      ).lines.map((l) => ({ productId: l.productId, quantity: l.quantity }));
    } catch {
      return { ok: false, error: 'Something in your basket cannot be sold right now.' };
    }
  }

  const totals = computeCheckoutTotals(priceable.map((l) => ({ productId: l.item.productId, quantity: l.item.quantity, unitPrice: l.unitPrice, taxRate: l.product.taxRate ?? 0, isTaxInclusive: l.product.isTaxInclusive !== false })));
  const productFacts = await drizzleDb.select({ id: productsTable.id, weight: productsTable.weight, inventoryKind: productsTable.inventoryKind }).from(productsTable).where(inArray(productsTable.id, [...new Set(stock.map((s) => s.productId))]));
  const factsById = new Map(productFacts.map((product) => [product.id, { weightKg: Number(product.weight ?? 0), inventoryKind: product.inventoryKind }]));
  const inventoryLines = stock.filter((line) => factsById.get(line.productId)?.inventoryKind === 'inventory');
  return {
    ok: true,
    subtotal: totals.subtotal,
    tax: totals.tax,
    goodsTotal: totals.subtotal + totals.tax,
    weightKg: stock.reduce((kg, line) => {
      const facts = factsById.get(line.productId);
      return facts?.inventoryKind === 'service' ? kg : kg + (facts?.weightKg ?? 0) * line.quantity;
    }, 0),
    stockLines: inventoryLines,
    currency: 'KES',
  };
}
