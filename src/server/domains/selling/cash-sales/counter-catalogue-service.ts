import { and, asc, eq, gt, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { categories, orderItems, orders, products } from '@/server/db/drizzle/schema';

export interface CounterTile {
  id: string;
  name: string;
  sku: string;
  price: number | null;
  imageUrl: string;
  categoryId: string | null;
  /** A package is built (choices, servings) before it is added; everything else is added with one tap. */
  isPackage: boolean;
  /** Units that can be sold now (on hand less reserved), or null for a service or an item that is not counted in stock. */
  inStock: number | null;
  lowStock: boolean;
}

export interface CounterCategory {
  id: string;
  name: string;
}

export const TILE_PAGE = 24;

interface TileRow {
  id: string;
  name: string;
  sku: string;
  price: string | null;
  imageUrl: string;
  categoryId: string | null;
  kind: string;
  stock: number;
  reserved: number;
  low: number;
  isPackage: boolean;
}

function toTile(r: TileRow): CounterTile {
  const free = r.kind === 'inventory' ? Math.max(r.stock - r.reserved, 0) : null;
  return { id: r.id, name: r.name, sku: r.sku, price: r.price === null ? null : Number(r.price), imageUrl: r.imageUrl, categoryId: r.categoryId, isPackage: r.isPackage, inStock: free, lowStock: free !== null && r.low > 0 && free <= r.low };
}

/** What the counter may sell: the same rule as the Add-a-product list, so a tile is never something the sale would refuse. */
const sellable = () =>
  and(eq(products.isActive, true), eq(products.isSellable, true), isNull(products.deletedAt), eq(products.soldOnlyInPackages, false), sql`'pos_cash_sale' = ANY(${products.offeredIn})`);

const likeSafe = (value: string): string => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** The tiles of the counter: categories, a page of products by category or search, and what this person sold most lately. */
export class CounterCatalogueService {
  constructor(private readonly db: DrizzleDb) {}

  async categories(): Promise<CounterCategory[]> {
    const rows = await this.db
      .select({ id: categories.id, name: categories.name })
      .from(categories)
      .where(and(eq(categories.isActive, true), sql`EXISTS (SELECT 1 FROM ${products} p WHERE p.category_id = "categories"."id" AND p.is_active AND p.is_sellable AND p.deleted_at IS NULL AND 'pos_cash_sale' = ANY(p.offered_in))`))
      .orderBy(asc(categories.displayOrder), asc(categories.name))
      .limit(60);
    return rows;
  }

  /** A page of tiles, by name: filtered by category and by a search over the name, SKU and stock code. `after` is the last name and id of the page before. */
  async page(input: { categoryId: string | null; query: string; after: { name: string; id: string } | null }): Promise<{ tiles: CounterTile[]; next: { name: string; id: string } | null }> {
    const q = input.query.trim().slice(0, 80);
    const filters = [
      sellable(),
      input.categoryId === null ? undefined : eq(products.categoryId, input.categoryId),
      q === '' ? undefined : or(ilike(products.name, `%${likeSafe(q)}%`), ilike(products.sku, `%${likeSafe(q)}%`), ilike(products.stockCode, `%${likeSafe(q)}%`)),
      input.after === null ? undefined : or(gt(products.name, input.after.name), and(eq(products.name, input.after.name), gt(products.id, input.after.id))),
    ];
    const rows = await this.db
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        price: products.price,
        imageUrl: products.imageUrl,
        categoryId: products.categoryId,
        kind: products.inventoryKind,
        stock: products.stockQuantity,
        reserved: products.reservedQuantity,
        low: products.lowStockThreshold,
        isPackage: sql<boolean>`EXISTS (SELECT 1 FROM product_packages pp WHERE pp.product_id = "products"."id" AND pp.is_active)`,
      })
      .from(products)
      .where(and(...filters))
      .orderBy(asc(products.name), asc(products.id))
      .limit(TILE_PAGE + 1);
    const more = rows.length > TILE_PAGE;
    const shown = more ? rows.slice(0, TILE_PAGE) : rows;
    const tiles = shown.map(toTile);
    const last = shown[shown.length - 1];
    return { tiles, next: more && last !== undefined ? { name: last.name, id: last.id } : null };
  }

  /** The products this person's counter sales took most often in the last weeks, for the Recent row (a quick start for the usual sale). */
  async recent(userId: string, since: Date): Promise<CounterTile[]> {
    const top = await this.db
      .select({ productId: orderItems.productId, n: sql<string>`COUNT(*)::text` })
      .from(orderItems)
      .innerJoin(orders, eq(orders.id, orderItems.orderId))
      .where(and(eq(orders.salesModule, 'pos_cash_sale'), eq(orders.userId, userId), sql`${orders.createdAt} >= ${since.toISOString()}::timestamptz`))
      .groupBy(orderItems.productId)
      .orderBy(sql`COUNT(*) DESC`)
      .limit(8);
    if (top.length === 0) return [];
    const ids = top.map((t) => t.productId);
    const rows = await this.db
      .select({ id: products.id, name: products.name, sku: products.sku, price: products.price, imageUrl: products.imageUrl, categoryId: products.categoryId, kind: products.inventoryKind, stock: products.stockQuantity, reserved: products.reservedQuantity, low: products.lowStockThreshold, isPackage: sql<boolean>`EXISTS (SELECT 1 FROM product_packages pp WHERE pp.product_id = "products"."id" AND pp.is_active)` })
      .from(products)
      .where(and(sellable(), inArray(products.id, ids)));
    const order = new Map(ids.map((id, n) => [id, n]));
    return rows.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0)).map(toTile);
  }

  /** One product by its exact SKU or stock code (a scanner types it and presses Enter), or null. */
  async byCode(code: string): Promise<CounterTile | null> {
    const c = code.trim().slice(0, 80);
    if (c === '') return null;
    const found = await this.page({ categoryId: null, query: c, after: null });
    const exact = found.tiles.find((t) => t.sku.toLowerCase() === c.toLowerCase());
    return exact ?? null;
  }
}
