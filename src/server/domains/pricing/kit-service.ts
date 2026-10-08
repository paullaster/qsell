import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { productKitComponents, productKits, products } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { PricingConfigError } from './config-service';
import {
  allocateKit,
  checkKit,
  splitTax,
  type KitAllocation,
  type KitComponentDef,
  type KitPart,
} from './domain/kits';
export { kitCost, kitTax } from './domain/kits';
import type { PriceTrace } from './domain/types';

type Why = ReasonInput;

/** A component with what a sale needs to know about it. */
export interface KitComponent extends KitComponentDef {
  name: string;
  sku: string;
  taxRate: number;
  isTaxInclusive: boolean;
  imageUrl: string;
  /** The component cannot be sold (deleted or switched off). */
  unavailable: boolean;
}

export interface Kit {
  id: string;
  productId: string;
  allocation: KitAllocation;
  components: KitComponent[];
}

/** A line of a sale, as expanding kits needs to see it. */
export interface SaleLine {
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  unitPrice: number;
  totalPrice: number;
  imageUrl: string;
  priceTrace?: PriceTrace | null;
  isGift?: boolean;
}

/** The tax that applies to a line: its own rate and whether the amount includes it. */
export interface LineTax {
  taxRate: number;
  isTaxInclusive: boolean;
}

export interface Expansion {
  lines: Array<SaleLine & LineTax>;
  /** What each kit line became, for the document's record. */
  kits: Array<{
    productId: string;
    name: string;
    quantity: number;
    total: number;
    parts: KitPart[];
  }>;
}

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/**
 * Turns each kit line into one line per component, each with its share of the price, its own
 * tax rate (in the kit line's tax basis, so the total stays exactly what was charged) and its
 * own stock. A component that is also on the sale as a line of its own, with the same tax, is
 * folded into that line, because returns and invoices work product by product.
 */
export function expandKits(
  lines: Array<SaleLine & LineTax>,
  kits: Map<string, Kit>,
  currency = 'KES',
): Expansion {
  const out: Array<SaleLine & LineTax> = [];
  const expanded: Expansion['kits'] = [];
  const add = (line: SaleLine & LineTax) => {
    const same = out.find(
      (o) =>
        o.productId === line.productId &&
        o.taxRate === line.taxRate &&
        o.isTaxInclusive === line.isTaxInclusive &&
        Boolean(o.isGift) === Boolean(line.isGift),
    );
    if (!same) return void out.push(line);
    same.quantity += line.quantity;
    same.totalPrice = round2(same.totalPrice + line.totalPrice);
    same.unitPrice = same.quantity > 0 ? round2(same.totalPrice / same.quantity) : 0;
  };

  for (const line of lines) {
    const kit = kits.get(line.productId);
    if (!kit) {
      add({ ...line });
      continue;
    }
    const gone = kit.components.find((c) => c.unavailable);
    if (gone)
      throw new KitError(
        `${line.productName} cannot be sold: its component ${gone.name} is no longer available.`,
      );
    const parts = allocateKit(line.totalPrice, line.quantity, kit.components, kit.allocation);
    expanded.push({
      productId: line.productId,
      name: line.productName,
      quantity: line.quantity,
      total: line.totalPrice,
      parts,
    });
    for (const part of parts) {
      const comp = kit.components.find((c) => c.productId === part.productId)!;
      add({
        productId: comp.productId,
        productName: `${comp.name} (${line.productName})`,
        sku: comp.sku,
        quantity: part.quantity,
        unitPrice: part.quantity > 0 ? round2(part.amount / part.quantity) : 0,
        totalPrice: part.amount,
        imageUrl: comp.imageUrl || line.imageUrl,
        isGift: line.isGift,
        // Its own tax rate; the amount keeps the kit line's basis so the total is unchanged.
        taxRate: comp.taxRate,
        isTaxInclusive: line.isTaxInclusive,
        priceTrace: {
          engineVersion: 1,
          at: new Date().toISOString(),
          inputs: { productId: comp.productId, quantity: part.quantity, currency },
          candidates: [],
          steps: [
            `Part of ${line.productName} (${line.quantity} sold): this component's share of the kit price is ${part.amount.toFixed(2)}.`,
          ],
          source: 'none',
          unitPrice: part.quantity > 0 ? round2(part.amount / part.quantity) : 0,
          lineTotal: part.amount,
          kit: {
            productId: line.productId,
            name: line.productName,
            quantity: line.quantity,
            total: line.totalPrice,
          },
        },
      });
    }
  }
  return { lines: out, kits: expanded };
}

export class KitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KitError';
  }
}

const TTL_MS = 10_000;

/** Finds kits for sales. Reads only; cached briefly and cleared when a kit changes. */
export class KitService {
  private cache = new Map<string, { at: number; value: Map<string, Kit> }>();

  constructor(private readonly db: DrizzleDb) {}

  invalidate(companyId?: string) {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  /** Every active kit in a company. Kits are few next to products, so one cached read serves a sale. */
  async all(companyId: string): Promise<Map<string, Kit>> {
    const hit = this.cache.get(companyId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const kits = await this.db
      .select()
      .from(productKits)
      .where(and(eq(productKits.companyId, companyId), eq(productKits.isActive, true)));
    const value = new Map<string, Kit>();
    if (kits.length > 0) {
      const rows = await this.db
        .select({
          kitId: productKitComponents.kitId,
          productId: productKitComponents.productId,
          quantity: productKitComponents.quantity,
          weight: productKitComponents.weight,
          sortOrder: productKitComponents.sortOrder,
          name: products.name,
          sku: products.sku,
          taxRate: products.taxRate,
          inclusive: products.isTaxInclusive,
          price: products.price,
          cost: products.costPrice,
          image: products.imageUrl,
          active: products.isActive,
          deleted: products.deletedAt,
        })
        .from(productKitComponents)
        .innerJoin(products, eq(products.id, productKitComponents.productId))
        .where(
          inArray(
            productKitComponents.kitId,
            kits.map((k) => k.id),
          ),
        )
        .orderBy(asc(productKitComponents.sortOrder));
      for (const k of kits)
        value.set(k.productId, {
          id: k.id,
          productId: k.productId,
          allocation: k.allocation,
          components: rows
            .filter((r) => r.kitId === k.id)
            .map((r) => ({
              productId: r.productId,
              quantity: r.quantity,
              weight: r.weight == null ? null : Number(r.weight),
              price: Number(r.price ?? 0),
              cost: Number(r.cost ?? 0),
              name: r.name,
              sku: r.sku,
              taxRate: Number(r.taxRate ?? 0),
              isTaxInclusive: r.inclusive !== false,
              imageUrl: r.image,
              unavailable: r.deleted != null || !r.active,
            })),
        });
    }
    this.cache.set(companyId, { at: Date.now(), value });
    return value;
  }

  /** The kits among these products. */
  async forProducts(companyId: string, productIds: string[]): Promise<Map<string, Kit>> {
    const all = await this.all(companyId);
    if (all.size === 0) return all;
    return new Map(productIds.filter((id) => all.has(id)).map((id) => [id, all.get(id)!]));
  }
}

export interface KitView {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  price: number | null;
  allocation: KitAllocation;
  isActive: boolean;
  version: number;
  components: Array<{
    productId: string;
    name: string;
    sku: string;
    quantity: number;
    weight: number | null;
    price: number | null;
    cost: number;
    stock: number;
  }>;
  /** What the components would sell for separately. */
  componentsWorth: number;
  /** Kits that can be made from the stock of the components right now. */
  buildable: number;
}

/** Everything an administrator does with kits. Each change needs a reason and is logged. */
export class KitConfigService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly kits: KitService,
  ) {}

  private why(companyId: string, reason: Why) {
    return this.reasons.require(companyId, reason, 'pricing_configuration');
  }

  async list(companyId: string): Promise<KitView[]> {
    const kits = await this.db
      .select()
      .from(productKits)
      .where(eq(productKits.companyId, companyId))
      .orderBy(asc(productKits.createdAt));
    if (kits.length === 0) return [];
    const [kitProducts, comps] = await Promise.all([
      this.db
        .select({ id: products.id, name: products.name, sku: products.sku, price: products.price })
        .from(products)
        .where(
          inArray(
            products.id,
            kits.map((k) => k.productId),
          ),
        ),
      this.db
        .select({
          kitId: productKitComponents.kitId,
          productId: productKitComponents.productId,
          quantity: productKitComponents.quantity,
          weight: productKitComponents.weight,
          sortOrder: productKitComponents.sortOrder,
          name: products.name,
          sku: products.sku,
          price: products.price,
          cost: products.costPrice,
          stock: products.stockQuantity,
          reserved: products.reservedQuantity,
        })
        .from(productKitComponents)
        .innerJoin(products, eq(products.id, productKitComponents.productId))
        .where(
          inArray(
            productKitComponents.kitId,
            kits.map((k) => k.id),
          ),
        )
        .orderBy(asc(productKitComponents.sortOrder)),
    ]);
    const byProduct = new Map(kitProducts.map((p) => [p.id, p]));
    return kits.map((k) => {
      const mine = comps.filter((c) => c.kitId === k.id);
      const p = byProduct.get(k.productId);
      return {
        id: k.id,
        productId: k.productId,
        productName: p?.name ?? k.productId,
        sku: p?.sku ?? '',
        price: p?.price == null ? null : Number(p.price),
        allocation: k.allocation,
        isActive: k.isActive,
        version: k.version,
        components: mine.map((c) => ({
          productId: c.productId,
          name: c.name,
          sku: c.sku,
          quantity: c.quantity,
          weight: c.weight == null ? null : Number(c.weight),
          price: c.price == null ? null : Number(c.price),
          cost: Number(c.cost ?? 0),
          stock: c.stock - c.reserved,
        })),
        componentsWorth: round2(mine.reduce((n, c) => n + Number(c.price ?? 0) * c.quantity, 0)),
        buildable: mine.length
          ? Math.max(
              0,
              Math.min(...mine.map((c) => Math.floor((c.stock - c.reserved) / c.quantity))),
            )
          : 0,
      };
    });
  }

  /**
   * Makes a kit of a product, or changes the one it already is. The product is sold as the kit;
   * its own stock is not used. A kit cannot hold another kit, and a product that is part of a kit
   * cannot itself become one.
   */
  async save(
    companyId: string,
    input: {
      productId: string;
      allocation: KitAllocation;
      components: Array<{ productId: string; quantity: number; weight?: number | null }>;
      isActive?: boolean;
    },
    actor: Actor,
    reason: Why,
  ): Promise<KitView> {
    const why = await this.why(companyId, reason);
    const [kitProduct] = await this.db
      .select({ id: products.id, name: products.name })
      .from(products)
      .where(and(eq(products.id, input.productId), isNull(products.deletedAt)))
      .limit(1);
    if (!kitProduct) throw new PricingConfigError('NOT_FOUND', 'That product does not exist.');

    const existingKits = await this.db
      .select({ productId: productKits.productId })
      .from(productKits)
      .where(eq(productKits.companyId, companyId));
    const others = new Set(
      existingKits.map((k) => k.productId).filter((id) => id !== input.productId),
    );
    const problems = checkKit(
      input.productId,
      input.allocation,
      input.components.map((c) => ({
        productId: c.productId,
        quantity: c.quantity,
        weight: c.weight ?? null,
      })),
      others,
    );
    // This product must not already be a component of another kit.
    const [asComponent] = await this.db
      .select({ kitId: productKitComponents.kitId })
      .from(productKitComponents)
      .where(eq(productKitComponents.productId, input.productId))
      .limit(1);
    if (asComponent)
      problems.push({
        path: 'productId',
        message: `${kitProduct.name} is a component of another kit, so it cannot also be a kit.`,
      });
    const ids = input.components.map((c) => c.productId);
    const live = ids.length
      ? await this.db
          .select({ id: products.id })
          .from(products)
          .where(and(inArray(products.id, ids), isNull(products.deletedAt)))
      : [];
    const known = new Set(live.map((p) => p.id));
    const gone = ids.filter((id) => !known.has(id));
    if (gone.length)
      problems.push({
        path: 'components',
        message: `${gone.length} component${gone.length === 1 ? '' : 's'} no longer exist.`,
      });
    if (problems.length) throw new PricingConfigError('INVALID', problems[0]!.message, problems);

    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(productKits)
        .where(eq(productKits.productId, input.productId))
        .for('update')
        .limit(1);
      let kitId: string;
      if (before) {
        kitId = before.id;
        await tx
          .update(productKits)
          .set({
            allocation: input.allocation,
            isActive: input.isActive ?? true,
            version: before.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(productKits.id, kitId));
        await tx.delete(productKitComponents).where(eq(productKitComponents.kitId, kitId));
      } else {
        const [row] = await tx
          .insert(productKits)
          .values({
            companyId,
            productId: input.productId,
            allocation: input.allocation,
            isActive: input.isActive ?? true,
            createdBy: actor.id ?? 'system',
          })
          .returning();
        kitId = row!.id;
      }
      await tx.insert(productKitComponents).values(
        input.components.map((c, i) => ({
          kitId,
          productId: c.productId,
          quantity: c.quantity,
          weight: c.weight == null ? null : c.weight.toFixed(4),
          sortOrder: i,
        })),
      );
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'product_kit', id: kitId },
          action: before ? 'pricing.kit_changed' : 'pricing.kit_created',
          reason: why,
          inputs: before ? { allocation: before.allocation, isActive: before.isActive } : {},
          outcome: {
            product: kitProduct.name,
            allocation: input.allocation,
            components: input.components.length,
            isActive: input.isActive ?? true,
          },
        },
        tx,
      );
    });
    this.kits.invalidate(companyId);
    return (await this.list(companyId)).find((k) => k.productId === input.productId)!;
  }

  /** Stops a product being a kit. It goes back to being an ordinary product. */
  async remove(companyId: string, productId: string, actor: Actor, reason: Why) {
    const why = await this.why(companyId, reason);
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(productKits)
        .where(and(eq(productKits.companyId, companyId), eq(productKits.productId, productId)))
        .returning();
      if (!row) throw new PricingConfigError('NOT_FOUND', 'That product is not a kit.');
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'product_kit', id: row.id },
          action: 'pricing.kit_removed',
          reason: why,
          inputs: { productId, allocation: row.allocation },
        },
        tx,
      );
    });
    this.kits.invalidate(companyId);
  }

  /** How a kit price would be split, for trying out settings before saving them. */
  async preview(
    companyId: string,
    input: {
      total: number;
      allocation: KitAllocation;
      components: Array<{ productId: string; quantity: number; weight?: number | null }>;
    },
  ) {
    const ids = input.components.map((c) => c.productId);
    const rows = ids.length
      ? await this.db
          .select({
            id: products.id,
            name: products.name,
            price: products.price,
            cost: products.costPrice,
            taxRate: products.taxRate,
          })
          .from(products)
          .where(inArray(products.id, ids))
      : [];
    const by = new Map(rows.map((r) => [r.id, r]));
    const parts = allocateKit(
      input.total,
      1,
      input.components.map((c) => ({
        productId: c.productId,
        quantity: c.quantity,
        weight: c.weight ?? null,
        price: Number(by.get(c.productId)?.price ?? 0),
        cost: Number(by.get(c.productId)?.cost ?? 0),
      })),
      input.allocation,
    );
    return parts.map((p) => ({
      productId: p.productId,
      name: by.get(p.productId)?.name ?? p.productId,
      quantity: p.quantity,
      amount: p.amount,
      taxRate: Number(by.get(p.productId)?.taxRate ?? 0),
    }));
  }
}
