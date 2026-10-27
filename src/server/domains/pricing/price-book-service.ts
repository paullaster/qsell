import { and, asc, count, eq, ilike, isNull, or } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { categories, products } from '@/server/db/drizzle/schema';
import { priceItemFor } from './service';
import { PricingConfigError } from './config-service';
import type { DiscountService, PricedItem } from './discount-service';
import type { PriceGuardService } from './guard-service';
import type { PricingService } from './service';

const MAX_PAGE = 200;
export const MAX_EXPORT = 5000;

export interface BookContext {
  customerId?: string | null;
  branchId?: string | null;
  channel?: string | null;
  salesType?: string | null;
  currency?: string | null;
}

export interface BookQuery {
  search?: string;
  categoryId?: string | null;
  brand?: string | null;
  limit?: number;
  offset?: number;
}

export interface BookRow {
  productId: string;
  sku: string;
  name: string;
  brand: string | null;
  category: string | null;
  /** What the price list or standard price gives one unit, tax left out. */
  listNet: number | null;
  /** After line discounts, tax left out. */
  effectiveNet: number | null;
  /** Gross (what the customer pays for one unit), in the line's tax basis. */
  effectiveUnit: number | null;
  taxRate: number;
  source: string;
  discounts: string[];
  costPrice: number;
  floorNet: number | null;
  belowFloor: boolean;
  marginPercent: number | null;
  problem: string | null;
}

export interface BookPage {
  rows: BookRow[];
  total: number;
  offset: number;
  limit: number;
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * The price book: what each product sells for one unit in a given situation (a customer, branch,
 * channel, currency), worked out live by the same engine that prices an order, with the line
 * discounts that would apply. It is the effective price, read for browsing and export. Nothing
 * is stored: the engine stays the only source of truth, so the book cannot go stale.
 */
export class PriceBookService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly pricing: PricingService,
    private readonly guard: PriceGuardService,
    private readonly discounts: DiscountService,
  ) {}

  private where(q: BookQuery) {
    const s = q.search?.trim().replace(/[%_]/g, '');
    return and(
      eq(products.isActive, true),
      isNull(products.deletedAt),
      eq(products.isSellable, true),
      q.categoryId ? eq(products.categoryId, q.categoryId) : undefined,
      q.brand ? eq(products.brand, q.brand) : undefined,
      s ? or(ilike(products.name, `%${s}%`), ilike(products.sku, `%${s}%`)) : undefined,
    );
  }

  async page(companyId: string, ctx: BookContext, q: BookQuery = {}): Promise<BookPage> {
    const limit = Math.min(Math.max(1, q.limit ?? 50), MAX_PAGE);
    const offset = Math.max(0, q.offset ?? 0);
    const where = this.where(q);
    const [{ total } = { total: 0 }] = await this.db
      .select({ total: count() })
      .from(products)
      .where(where);
    const prods = await this.db
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
        brand: products.brand,
        category: categories.name,
        price: products.price,
        standardPrice: products.standardPrice,
        cost: products.costPrice,
        taxRate: products.taxRate,
        inclusive: products.isTaxInclusive,
      })
      .from(products)
      .leftJoin(categories, eq(categories.id, products.categoryId))
      .where(where)
      .orderBy(asc(products.name), asc(products.id))
      .limit(limit)
      .offset(offset);
    return { rows: await this.price(companyId, ctx, prods), total: Number(total), offset, limit };
  }

  /** Every product that matches, up to the export limit, for a spreadsheet. */
  async export(
    companyId: string,
    ctx: BookContext,
    q: BookQuery = {},
  ): Promise<{ rows: BookRow[]; truncated: boolean }> {
    const out: BookRow[] = [];
    let offset = 0;
    for (;;) {
      const p = await this.page(companyId, ctx, { ...q, limit: MAX_PAGE, offset });
      out.push(...p.rows);
      offset += MAX_PAGE;
      if (offset >= p.total || out.length >= MAX_EXPORT)
        return { rows: out.slice(0, MAX_EXPORT), truncated: p.total > MAX_EXPORT };
    }
  }

  private async price(
    companyId: string,
    ctx: BookContext,
    prods: Array<{
      id: string;
      sku: string;
      name: string;
      brand: string | null;
      category: string | null;
      price: string | null;
      standardPrice: string | null;
      cost: string;
      taxRate: string | null;
      inclusive: boolean | null;
    }>,
  ): Promise<BookRow[]> {
    if (prods.length === 0) return [];
    const sale = {
      customerId: ctx.customerId ?? null,
      branchId: ctx.branchId ?? null,
      channel: ctx.channel ?? 'sales_order',
      salesType: ctx.salesType ?? null,
      currency: ctx.currency ?? null,
    };
    const results = await this.pricing.priceLines(
      companyId,
      sale,
      prods.map((p) =>
        priceItemFor(
          {
            id: p.id,
            price: p.price == null ? null : Number(p.price),
            standardPrice: p.standardPrice == null ? null : Number(p.standardPrice),
            taxRate: p.taxRate == null ? null : Number(p.taxRate),
            isTaxInclusive: p.inclusive,
          },
          1,
        ),
      ),
    );
    // Line discounts on what was priced; order rules need a whole basket and are left out.
    const items: PricedItem[] = [];
    const at = new Map<number, number>();
    results.forEach((r, i) => {
      if (r.unitPrice == null) return;
      at.set(i, items.length);
      items.push({
        productId: prods[i]!.id,
        quantity: 1,
        unitPrice: r.unitPrice,
        lineTotal: r.unitPrice,
        taxRate: prods[i]!.taxRate == null ? 0 : Number(prods[i]!.taxRate),
        lineTaxInclusive: prods[i]!.inclusive !== false,
        trace: r.trace,
      });
    });
    const basket = items.length
      ? await this.discounts.evaluate(
          companyId,
          { ...sale, salesType: sale.salesType ?? 'cash' },
          items,
          {
            stages: { order: false },
          },
        )
      : null;
    const floors = await this.guard.floorsFor(
      companyId,
      prods.map((p) => p.id),
    );
    return prods.map((p, i) => {
      const res = results[i]!;
      const rate = p.taxRate == null ? 0 : Number(p.taxRate);
      const inclusive = p.inclusive !== false;
      const net = (v: number) => (inclusive ? v / (1 + rate / 100) : v);
      const bi = at.get(i);
      const line = bi == null ? null : basket?.lines[bi];
      const unit = res.unitPrice == null ? null : (line?.unitPriceAfter ?? res.unitPrice);
      const effectiveNet = unit == null ? null : r2(net(unit));
      const cost = Number(p.cost);
      const floorNet = floors.get(p.id)?.floorNet ?? null;
      return {
        productId: p.id,
        sku: p.sku,
        name: p.name,
        brand: p.brand,
        category: p.category,
        listNet: res.unitPrice == null ? null : r2(net(res.unitPrice)),
        effectiveNet,
        effectiveUnit: unit == null ? null : r2(unit),
        taxRate: rate,
        source:
          res.trace.source === 'price_list' && res.trace.winner
            ? `List ${res.trace.winner.listCode}`
            : res.trace.source === 'standard'
              ? 'Standard price'
              : 'No price',
        discounts: (line?.trace.applied ?? []).map((a) => a.name),
        costPrice: cost,
        floorNet,
        belowFloor: floorNet != null && effectiveNet != null && effectiveNet + 0.005 < floorNet,
        marginPercent:
          effectiveNet != null && effectiveNet > 0 && cost > 0
            ? Math.round(((effectiveNet - cost) / effectiveNet) * 1000) / 10
            : null,
        problem: res.unitPrice == null ? 'This product cannot be priced here.' : null,
      };
    });
  }

  /** A book as CSV text, with a header, ready to save as a file. */
  static toCsv(rows: BookRow[]): string {
    const esc = (v: unknown) => {
      const s = v == null ? '' : String(v);
      // A leading =, +, - or @ would be run as a formula by a spreadsheet.
      const safe = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
      return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
    };
    const head = [
      'SKU',
      'Product',
      'Brand',
      'Category',
      'List price (net)',
      'Price after discounts (net)',
      'Price after discounts (as sold)',
      'Tax %',
      'Source',
      'Discounts',
      'Cost',
      'Floor (net)',
      'Below floor',
      'Margin %',
    ];
    const lines = rows.map((r) =>
      [
        r.sku,
        r.name,
        r.brand,
        r.category,
        r.listNet,
        r.effectiveNet,
        r.effectiveUnit,
        r.taxRate,
        r.source,
        r.discounts.join('; '),
        r.costPrice || '',
        r.floorNet,
        r.belowFloor ? 'yes' : '',
        r.marginPercent,
      ]
        .map(esc)
        .join(','),
    );
    return [head.join(','), ...lines].join('\n');
  }
}
