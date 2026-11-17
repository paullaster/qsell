import { inArray } from 'drizzle-orm';
import { computeCheckoutTotals } from '@/lib/checkoutPricing';
import { priceItemFor } from '@/server/domains/pricing/service';
import { expandKits } from '@/server/domains/pricing/kit-service';
import type { BasketItem } from '@/lib/basket-items';
import type { PreparedPackage } from '@/server/domains/pricing/package-order-service';
import { CatalogService } from '@/server/domains/catalog/service';
import { getContainer } from '@/server/di/container';
import { drizzleDb } from '@/server/db/drizzle/client';
import { products as productsTable } from '@/server/db/drizzle/schema';
import { firstFilled, nth, orElse } from '@/lib/values';
import { lineAmounts } from './write-service';
import { inventoryStockLines } from '@/lib/inventory-kind';

export interface BasketPromotions {
  /** Taken off the goods (tax included in the same basis the prices are in). */
  discount: number;
  /** The promotions that gave it, by name, and the codes that were used. */
  applied: { name: string; code: string }[];
  gifts: { name: string; quantity: number }[];
  /** Promo codes that cannot be used, with why. The order is refused while one is typed. */
  couponProblems: { code: string; reason: string }[];
}

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
      /** What promotions and promo codes did to this basket, as the order will apply them. */
      promotions: BasketPromotions;
      currency: 'KES';
    }
  | { ok: false; error: string };

/**
 * What a shop basket comes to, priced the way the shop prices an order (the same price lists, for the same customer, at the same
 * branch), so the value and the weight a delivery charge is worked from are the ones the order will have. The order is the
 * authority; if anything here differs, the order's own charge differs and the shopper is told before paying.
 */
export async function previewShopBasket(rawItems: readonly BasketItem[], customerId: string | null, options: { couponCodes?: readonly string[]; paymentMethod?: string | null } = {}): Promise<BasketPreview> {
  const items = rawItems;
  const { companySettings, organizations, branches, pricing, kits, discounts, packageOrders } = getContainer();
  const company = await companySettings.ensureSeeded();
  const { branch } = await organizations.ensureDefaultOrgAndBranch(company.id, orElse(firstFilled(company.tradingName, company.legalName), 'Company'));
  const sellingBranch = (await branches.getDefault(company.id)) ?? branch;
  const found = new Map((await CatalogService.getProductsByIds(items.map((i) => i.productId))).map((p) => [p.id, p]));

  const sellable = items.filter((i) => found.get(i.productId)?.isSellable === true && found.get(i.productId)?.showOnWebShop === true && found.get(i.productId)?.soldOnlyInPackages !== true);
  if (sellable.length !== items.length || sellable.length === 0) return { ok: false, error: 'Something in your basket is no longer for sale. Please look at your basket again.' };
  // Package lines: the choices are checked as the order will check them (the audience and ordering rules are left to the order itself).
  const preparedPackages = new Map<number, PreparedPackage>();
  const wanted = items.flatMap((item, index) => (item.package === undefined ? [] : [{ index, productId: item.productId, picks: item.package.picks, servings: item.quantity, ...(item.package.note === undefined ? {} : { note: item.package.note }) }]));
  if (wanted.length > 0) {
    const prepared = await packageOrders.prepare({ companyId: company.id, customerGroupId: await pricing.groupFor(company.id, customerId), signedIn: customerId !== null, forDate: null, now: new Date(), previewOnly: true }, wanted);
    if (!prepared.ok) return { ok: false, error: prepared.error };
    for (const line of prepared.lines) preparedPackages.set(line.index, line);
  }
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
    const base = lineAmounts(undefined, result, product.price, item.quantity);
    // A package serving costs the base price plus what the choices add (or the choices' own prices, added up).
    const chosen = preparedPackages.get(n);
    const unitPrice = chosen === undefined ? base.unitPrice : Math.round(((chosen.summedPerServing ?? base.unitPrice + (chosen.addedPerServing ?? 0)) + Number.EPSILON) * 100) / 100;
    const total = chosen === undefined ? base.total : Math.round((unitPrice * item.quantity + Number.EPSILON) * 100) / 100;
    return { item, product, unitPrice, total, result };
  });
  if (lines.some((l) => l === null)) return { ok: false, error: 'Something in your basket cannot be priced right now.' };
  const priceable = lines.flatMap((l) => (l === null ? [] : [l]));

  // Promotions and promo codes, worked out as the order works them out, so what is shown is what is charged.
  const discounted = await discounts.evaluate(
    company.id,
    { customerId, branchId: sellingBranch.id, salesType: 'cash', channel: 'ecommerce', paymentMethod: options.paymentMethod ?? null },
    priceable.map((l) => ({ productId: l.item.productId, quantity: l.item.quantity, unitPrice: l.unitPrice, lineTotal: l.total, taxRate: l.product.taxRate ?? 0, lineTaxInclusive: l.product.isTaxInclusive !== false, explicitFloorUnit: l.result?.trace.floorPrice ?? null, trace: l.result?.trace ?? null })),
    { couponCodes: [...(options.couponCodes ?? [])] },
  );
  priceable.forEach((l, n) => {
    const b = discounted.lines[n];
    if (b !== undefined && b.lineDiscount + b.orderDiscount > 0) {
      l.unitPrice = b.unitPriceAfter;
      l.total = b.lineTotalAfter;
    }
  });
  const promotions: BasketPromotions = {
    discount: discounted.totalDiscount,
    applied: discounted.applications.map((a) => ({ name: a.couponCode ?? a.code, code: a.code })),
    gifts: discounted.gifts.map((g) => ({ name: g.productName, quantity: g.quantity })),
    couponProblems: discounted.couponProblems,
  };

  const kitDefs = new Map(await kits.forProducts(company.id, priceable.map((l) => l.item.productId)));
  for (const line of preparedPackages.values()) kitDefs.set(line.kit.productId, line.kit);
  let stock = [...priceable.map((l) => ({ productId: l.item.productId, quantity: l.item.quantity })), ...discounted.gifts.map((g) => ({ productId: g.productId, quantity: g.quantity }))];
  // What is taxed: the lines as the order will have them. A kit is taxed part by part, each at its own rate.
  let taxed = priceable.map((l) => ({ productId: l.item.productId, quantity: l.item.quantity, unitPrice: l.unitPrice, taxRate: l.product.taxRate ?? 0, isTaxInclusive: l.product.isTaxInclusive !== false }));
  if (kitDefs.size > 0) {
    try {
      const expansion = expandKits(
        priceable.map((l, n) => ({ productId: preparedPackages.get(n)?.kit.productId ?? l.item.productId, productName: l.product.name, sku: l.product.sku, quantity: l.item.quantity, unitPrice: l.unitPrice, totalPrice: l.total, imageUrl: l.product.imageUrl, taxRate: l.product.taxRate ?? 0, isTaxInclusive: l.product.isTaxInclusive !== false })),
        kitDefs,
      );
      stock = expansion.lines.map((l) => ({ productId: l.productId, quantity: l.quantity }));
      taxed = expansion.lines.map((l) => ({ productId: l.productId, quantity: l.quantity, unitPrice: l.quantity > 0 ? l.totalPrice / l.quantity : 0, taxRate: l.taxRate, isTaxInclusive: l.isTaxInclusive }));
    } catch {
      // The message names the kit (not the part), so the shopper knows which line to take out.
      const kit = priceable.find((l) => kitDefs.has(l.item.productId) && kitDefs.get(l.item.productId)?.components.some((c) => c.unavailable) === true);
      return { ok: false, error: kit === undefined ? 'Something in your basket cannot be sold right now.' : `${kit.product.name} cannot be sold right now. Please take it out of your basket.` };
    }
  }

  const totals = computeCheckoutTotals(taxed);
  const productFacts = await drizzleDb.select({ id: productsTable.id, weight: productsTable.weight, inventoryKind: productsTable.inventoryKind }).from(productsTable).where(inArray(productsTable.id, [...new Set(stock.map((s) => s.productId))]));
  const factsById = new Map(productFacts.map((product) => [product.id, { weightKg: Number(product.weight ?? 0), inventoryKind: product.inventoryKind }]));
  const inventoryLines = inventoryStockLines(stock, new Map(productFacts.map((product) => [product.id, product.inventoryKind])));
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
    promotions,
    currency: 'KES',
  };
}
