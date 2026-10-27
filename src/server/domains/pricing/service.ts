import { and, asc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  currencies,
  customerGroupMembers,
  customerGroups,
  customers,
  priceListLines,
  priceLists,
  priceSpecificityWeights,
} from '@/server/db/drizzle/schema';
import { effectiveStandardPrice } from '@/lib/standard-price';
import { chooseGroup, resolvePrice } from './domain/resolve';
import {
  DEFAULT_WEIGHTS,
  type PriceContext,
  type PriceItemInput,
  type PriceListHeader,
  type PriceListLine,
  type PriceResult,
  type SpecificityWeights,
} from './domain/types';

type ListRow = typeof priceLists.$inferSelect;
type LineRow = typeof priceListLines.$inferSelect;

export const toHeader = (r: ListRow): PriceListHeader => ({
  id: r.id,
  code: r.code,
  name: r.name,
  kind: r.kind,
  currency: r.currency,
  taxInclusive: r.taxInclusive,
  quantityMode: r.quantityMode,
  priority: r.priority,
  validFrom: r.validFrom,
  validTo: r.validTo,
  scopes: r.scopes ?? {},
  version: r.version,
});

export const toLine = (r: LineRow): PriceListLine => ({
  id: r.id,
  priceListId: r.priceListId,
  productId: r.productId,
  price: Number(r.price),
  tiers: (r.tiers ?? []).map((t) => ({ fromQty: Number(t.fromQty), price: Number(t.price) })),
  floorPrice: r.floorPrice == null ? null : Number(r.floorPrice),
  lockedUntil: r.lockedUntil,
  validFrom: r.validFrom,
  validTo: r.validTo,
});

/** What the engine needs to know about a product to price it. */
export interface PriceableProduct {
  id: string;
  price?: number | null;
  standardPrice?: number | null;
  taxRate?: number | null;
  isTaxInclusive?: boolean | null;
}

/**
 * The one place that turns a product and a quantity into what the engine prices: its standard price (its own, else the selling
 * price) in the product's own tax basis. Every channel, the shop's display and the price book build their items here.
 */
export function priceItemFor(product: PriceableProduct, quantity: number): PriceItemInput {
  const inclusive = product.isTaxInclusive !== false;
  return {
    productId: product.id,
    quantity,
    standardPrice: effectiveStandardPrice(product),
    taxRate: Math.max(0, product.taxRate ?? 0),
    lineTaxInclusive: inclusive,
    standardTaxInclusive: inclusive,
  };
}

/** Active list headers, weights and currencies are read often and change rarely. */
const CACHE_MS = 10_000;

interface Snapshot {
  at: number;
  headers: PriceListHeader[];
  weights: SpecificityWeights;
  currencies: Map<string, { rate: number; decimals: number; isBase: boolean }>;
  base: string;
}

/** What the caller knows about the sale. */
export interface SaleFacts {
  at?: Date;
  currency?: string | null;
  customerId?: string | null;
  branchId?: string | null;
  /** cash | credit */
  salesType?: string | null;
  /** The invoicing module: ecommerce, sales_order, credit_sale, pos_cash_sale. */
  channel?: string | null;
  route?: string | null;
  country?: string | null;
}

/**
 * Prices lines: loads the configuration, then asks the pure engine. Reads only; nothing here
 * changes data. Configuration is cached for a few seconds per process and dropped at once when
 * this process changes it, so another instance sees a change within the cache time.
 */
export class PricingService {
  private readonly cache = new Map<string, Snapshot>();

  constructor(private readonly db: DrizzleDb) {}

  invalidate(companyId: string) {
    this.cache.delete(companyId);
  }

  private async snapshot(companyId: string): Promise<Snapshot> {
    const hit = this.cache.get(companyId);
    if (hit && Date.now() - hit.at < CACHE_MS) return hit;
    const [headers, weightRows, currencyRows] = await Promise.all([
      this.db
        .select()
        .from(priceLists)
        .where(and(eq(priceLists.companyId, companyId), eq(priceLists.status, 'active'))),
      this.db
        .select()
        .from(priceSpecificityWeights)
        .where(eq(priceSpecificityWeights.companyId, companyId)),
      this.db.select().from(currencies),
    ]);
    const weights: SpecificityWeights = { ...DEFAULT_WEIGHTS };
    for (const w of weightRows) {
      if (w.dimension in weights) weights[w.dimension as keyof SpecificityWeights] = w.weight;
    }
    const cur = new Map(
      currencyRows.map((c) => [
        c.code,
        { rate: Number(c.exchangeRate), decimals: c.decimalDigits, isBase: c.isBaseCurrency },
      ]),
    );
    const base = currencyRows.find((c) => c.isBaseCurrency)?.code ?? 'KES';
    const snap: Snapshot = {
      at: Date.now(),
      headers: headers.map(toHeader),
      weights,
      currencies: cur,
      base,
    };
    this.cache.set(companyId, snap);
    return snap;
  }

  async weights(companyId: string): Promise<SpecificityWeights> {
    return (await this.snapshot(companyId)).weights;
  }

  async baseCurrency(companyId: string): Promise<string> {
    return (await this.snapshot(companyId)).base;
  }

  /** The group that prices this customer's sales: the highest-priority one they belong to. */
  async groupFor(companyId: string, customerId: string | null | undefined): Promise<string | null> {
    if (!customerId) return null;
    const rows = await this.db
      .select({
        id: customerGroups.id,
        code: customerGroups.code,
        priority: customerGroups.priority,
      })
      .from(customerGroupMembers)
      .innerJoin(customerGroups, eq(customerGroups.id, customerGroupMembers.groupId))
      .where(
        and(
          eq(customerGroupMembers.customerId, customerId),
          eq(customerGroups.companyId, companyId),
          eq(customerGroups.isActive, true),
        ),
      );
    return chooseGroup(rows);
  }

  /** Builds the engine's view of a sale. */
  async contextFor(companyId: string, sale: SaleFacts): Promise<PriceContext> {
    const snap = await this.snapshot(companyId);
    const currency = sale.currency || snap.base;
    const meta = snap.currencies.get(currency);
    const baseMeta = snap.currencies.get(snap.base);
    // The rate is held against the base currency; the base itself is always 1.
    const rate = currency === snap.base ? 1 : (meta?.rate ?? 0) / (baseMeta?.rate || 1);
    let country = sale.country ?? null;
    if (!country && sale.customerId) {
      const [c] = await this.db
        .select({ country: customers.country })
        .from(customers)
        .where(eq(customers.id, sale.customerId))
        .limit(1);
      country = c?.country ?? null;
    }
    return {
      at: sale.at ?? new Date(),
      currency,
      baseCurrency: snap.base,
      rateFromBase: rate,
      decimals: meta?.decimals ?? 2,
      customerId: sale.customerId ?? null,
      customerGroupId: await this.groupFor(companyId, sale.customerId),
      route: sale.route ?? null,
      branchId: sale.branchId ?? null,
      salesType: sale.salesType ?? null,
      channel: sale.channel ?? null,
      // Only an ISO two-letter code can be matched; a free-text country name cannot.
      country:
        country && /^[A-Za-z]{2}$/.test(country.trim()) ? country.trim().toUpperCase() : null,
    };
  }

  /**
   * Prices every item of a sale. Two queries however many items: the lists in force are cached,
   * and the lines of all items are fetched together.
   */
  async priceLines(
    companyId: string,
    sale: SaleFacts,
    items: PriceItemInput[],
  ): Promise<PriceResult[]> {
    const ctx = await this.contextFor(companyId, sale);
    const snap = await this.snapshot(companyId);
    const productIds = [...new Set(items.map((i) => i.productId))];
    const byProduct = new Map<string, Array<{ header: PriceListHeader; line: PriceListLine }>>();
    if (productIds.length > 0 && snap.headers.length > 0) {
      const headerById = new Map(snap.headers.map((h) => [h.id, h]));
      const rows = await this.db
        .select()
        .from(priceListLines)
        .where(
          and(
            inArray(priceListLines.priceListId, [...headerById.keys()]),
            inArray(priceListLines.productId, productIds),
            lte(priceListLines.validFrom, ctx.at),
            or(isNull(priceListLines.validTo), gt(priceListLines.validTo, ctx.at)),
          ),
        )
        .orderBy(asc(priceListLines.productId));
      for (const r of rows) {
        const header = headerById.get(r.priceListId);
        if (!header) continue;
        const bucket = byProduct.get(r.productId) ?? [];
        bucket.push({ header, line: toLine(r) });
        byProduct.set(r.productId, bucket);
      }
    }
    return items.map((item) =>
      resolvePrice(item, ctx, byProduct.get(item.productId) ?? [], snap.weights),
    );
  }
}
