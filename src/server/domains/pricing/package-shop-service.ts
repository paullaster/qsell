import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { products } from '@/server/db/drizzle/schema';
import type { StockAvailability } from '@/server/domains/stock/availability';
import type { StockSettingsService } from '@/server/domains/stock/settings';
import { checkPackageBasket, packageAvailable, type BasketLineView, type LineStock, type PackageLineInput, type ShopPackage } from './domain/package-shop';
import { type PackageConfigService, type PackageView } from './package-service';


export interface ShopBuilder {
  package: ShopPackage;
  /** Option ids that can be chosen for the servings asked about. */
  available: string[];
  /** False when a required slot has nothing left to choose. */
  offered: boolean;
}

const MAX_BASKET_PACKAGES = 20;

/**
 * What the web shop shows and checks for configurable packages. The browser sends ids and counts; every price, quantity and stock
 * figure is decided here. Only packages that are switched on, whose product is for sale on the web, are ever offered.
 */
export class PackageShopService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly packages: PackageConfigService,
    private readonly stockSettings: StockSettingsService,
    private readonly stockAvailability: StockAvailability,
  ) {}

  /** The packages among these products that the shop may offer, with the stock facts to judge them. */
  private async load(companyId: string, productIds: readonly string[]): Promise<{ packages: Map<string, ShopPackage>; stock: LineStock; views: Map<string, PackageView> }> {
    const ids = [...new Set(productIds)].slice(0, MAX_BASKET_PACKAGES);
    const views = ids.length === 0 ? [] : await this.packages.list(companyId, ids);
    const forSale = views.length === 0
      ? []
      : await this.db
          .select({ id: products.id })
          .from(products)
          .where(and(inArray(products.id, views.map((v) => v.productId)), eq(products.isActive, true), eq(products.isSellable, true), eq(products.showOnWebShop, true), eq(products.isCheckoutPackaging, false), isNull(products.deletedAt)));
    const sellable = new Set(forSale.map((r) => r.id));
    const offered = views.filter((v) => v.isActive && sellable.has(v.productId));

    // Free stock per product: the counters, or the places that sell to the web shop when the ledger is the truth.
    const free = new Map<string, number>();
    const unlimited = new Set<string>();
    const optionProducts = new Map<string, { stock: number; managed: boolean }>();
    for (const view of offered) for (const slot of view.slots) for (const o of slot.options) optionProducts.set(o.productId, { stock: o.stock, managed: o.managed });
    for (const [productId, facts] of optionProducts) {
      if (facts.managed) free.set(productId, Math.max(0, facts.stock));
      else unlimited.add(productId);
    }
    if (optionProducts.size > 0 && (await this.stockSettings.isLedgerMode())) {
      const found = await this.stockAvailability.forProducts([...optionProducts.keys()], 'ecommerce');
      for (const productId of free.keys()) {
        const a = found.get(productId);
        free.set(productId, a === undefined ? 0 : Math.max(0, a.onHand - a.reserved));
      }
    }

    const shop = new Map(offered.map((v) => [v.productId, toShopPackage(v)]));
    return { packages: shop, stock: { free, unlimited }, views: new Map(offered.map((v) => [v.productId, v])) };
  }

  /** The builder for one package product, or null when it is not a package the shop offers. `servings` decides which options still have stock. */
  async builder(companyId: string, productId: string, servings = 1): Promise<ShopBuilder | null> {
    const { packages, stock } = await this.load(companyId, [productId]);
    const pkg = packages.get(productId);
    if (pkg === undefined) return null;
    const count = Number.isInteger(servings) && servings >= 1 && servings <= 1000 ? servings : 1;
    const available = new Set<string>();
    for (const slot of pkg.slots) {
      for (const o of slot.options) {
        const free = stock.unlimited.has(o.productId) ? Number.POSITIVE_INFINITY : (stock.free.get(o.productId) ?? 0);
        if (free + 1e-9 >= o.quantity * count) available.add(o.id);
      }
    }
    return { package: pkg, available: [...available], offered: packageAvailable(pkg, available) };
  }

  /** Whether each of these products is a package the shop offers (the page decides between the plain purchase panel and the builder). */
  async offers(companyId: string, productId: string): Promise<boolean> {
    return (await this.load(companyId, [productId])).packages.has(productId);
  }

  /** Checks and prices the package lines of a basket, in order: each sees what the lines before it take from stock. */
  async basket(companyId: string, lines: readonly PackageLineInput[]): Promise<BasketLineView[]> {
    const clipped = lines.slice(0, MAX_BASKET_PACKAGES);
    const { packages, stock } = await this.load(companyId, clipped.map((l) => l.productId));
    return checkPackageBasket(packages, clipped, stock).map((r) => (r.ok ? { ok: true, key: r.key, servings: r.servings, servingPrice: r.servingPrice, total: r.total, summary: r.summary } : r));
  }
}

/** The shop's view of a package: options that cannot be sold (switched off or deleted) are left out, and no cost or stock count is shown. */
export function toShopPackage(view: PackageView): ShopPackage {
  return {
    productId: view.productId,
    name: view.productName,
    basePrice: view.price ?? 0,
    pricingMode: view.pricingMode,
    shortStockMode: view.shortStockMode,
    version: view.version,
    slots: view.slots.map((slot) => ({
      id: slot.id,
      name: slot.name,
      helpText: slot.helpText,
      minPicks: slot.minPicks,
      maxPicks: slot.maxPicks,
      allowRepeats: slot.allowRepeats,
      included: slot.included,
      options: slot.options
        .filter((o) => !o.unavailable)
        .map((o) => ({
          id: o.id,
          productId: o.productId,
          name: o.name,
          quantity: o.quantity,
          difference: o.difference,
          price: o.ownPrice ?? (o.productPrice === null ? null : Math.round((o.productPrice * o.quantity + Number.EPSILON) * 100) / 100),
          isDefault: o.isDefault,
        })),
    })),
  };
}
