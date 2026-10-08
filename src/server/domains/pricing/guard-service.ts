import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  priceFloorRules,
  priceOverrideLimits,
  productGroupMembers,
  productGroups,
  productKitComponents,
  productKits,
  products,
  categories,
} from '@/server/db/drizzle/schema';
import type { AccessControlService } from '@/server/domains/access-control/engine';
import { categoryChain } from '@/server/domains/catalog/category-tree';
import {
  describeRule,
  limitFor,
  reductionPercent,
  resolveFloor,
  shortfallPercent,
} from './domain/floor';
import type { FloorProduct, FloorResult, FloorRule, GuardTrace } from './domain/types';

const TTL_MS = 10_000;
/** A price within half a cent of its floor is at it, not under it. */
const EPSILON = 0.005;

/** A document line as the guard needs to see it. Amounts are net of tax, in the base currency. */
export interface GuardLine {
  productId: string;
  /** What to call the line in messages (the product's name). */
  label?: string;
  quantity: number;
  /** The unit price actually being charged, after line discounts. Null when it has no price. */
  netUnit: number | null;
  /** What the price list says this unit costs the customer, to measure an override against. */
  listNetUnit?: number | null;
  /**
   * The unit price after line discounts only (not a whole-document discount), to measure the
   * override with. Defaults to `netUnit`.
   */
  overrideNetUnit?: number | null;
  /** A floor typed into the price list line the price came from (already net of tax). */
  explicitFloorNet?: number | null;
}

export interface GuardAssessment {
  lines: GuardTrace[];
  /** Any line below its floor. */
  belowFloor: boolean;
  largestShortfallPercent: number;
  /** Lines whose floor says "refuse", worded for the person. */
  blocked: string[];
  /** The biggest reduction from list price on any line. */
  largestOverridePercent: number;
  /** This person's limit, or null for none. */
  overrideLimitPercent: number | null;
  overOverrideLimit: boolean;
  /** Something here needs a decision from someone else. */
  needsApproval: boolean;
}

type Cached<T> = { at: number; value: T };

/**
 * Checks prices against the floors and override limits. Reads are cached for a few seconds and
 * cleared whenever the rules change here; the checks themselves are a few queries per basket.
 */
export class PriceGuardService {
  private rulesCache = new Map<string, Cached<FloorRule[]>>();
  private limitsCache = new Map<string, Cached<Array<{ roleKey: string; maxPercent: number }>>>();
  private parentsCache: Cached<Map<string, string | null>> | null = null;

  constructor(
    private readonly db: DrizzleDb,
    private readonly access: Pick<AccessControlService, 'snapshot'>,
  ) {}

  invalidate(companyId?: string) {
    if (companyId) {
      this.rulesCache.delete(companyId);
      this.limitsCache.delete(companyId);
    } else {
      this.rulesCache.clear();
      this.limitsCache.clear();
    }
    this.parentsCache = null;
  }

  async rules(companyId: string): Promise<FloorRule[]> {
    const hit = this.rulesCache.get(companyId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const rows = await this.db
      .select()
      .from(priceFloorRules)
      .where(and(eq(priceFloorRules.companyId, companyId), eq(priceFloorRules.isActive, true)));
    const value = rows.map<FloorRule>((r) => ({
      id: r.id,
      scopeType: r.scopeType,
      scopeRef: r.scopeRef,
      markupPercent: Number(r.markupPercent),
      enforcement: r.enforcement,
    }));
    this.rulesCache.set(companyId, { at: Date.now(), value });
    return value;
  }

  async limits(companyId: string) {
    const hit = this.limitsCache.get(companyId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const rows = await this.db
      .select()
      .from(priceOverrideLimits)
      .where(eq(priceOverrideLimits.companyId, companyId));
    const value = rows.map((r) => ({ roleKey: r.roleKey, maxPercent: Number(r.maxPercent) }));
    this.limitsCache.set(companyId, { at: Date.now(), value });
    return value;
  }

  async categoryParents(): Promise<Map<string, string | null>> {
    if (this.parentsCache && Date.now() - this.parentsCache.at < TTL_MS)
      return this.parentsCache.value;
    const rows = await this.db
      .select({ id: categories.id, parentId: categories.parentId })
      .from(categories);
    const value = new Map(rows.map((r) => [r.id, r.parentId]));
    this.parentsCache = { at: Date.now(), value };
    return value;
  }

  /** Products as the floor sees them: cost, brand, category chain and groups. */
  async floorProducts(companyId: string, productIds: string[]): Promise<Map<string, FloorProduct>> {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return new Map();
    const [rows, parents, memberships] = await Promise.all([
      this.db
        .select({
          id: products.id,
          cost: products.costPrice,
          brand: products.brand,
          categoryId: products.categoryId,
        })
        .from(products)
        .where(and(inArray(products.id, ids), isNull(products.deletedAt))),
      this.categoryParents(),
      this.db
        .select({ productId: productGroupMembers.productId, groupId: productGroupMembers.groupId })
        .from(productGroupMembers)
        .innerJoin(productGroups, eq(productGroups.id, productGroupMembers.groupId))
        .where(
          and(
            inArray(productGroupMembers.productId, ids),
            eq(productGroups.companyId, companyId),
            eq(productGroups.isActive, true),
          ),
        ),
    ]);
    // A kit costs what its components cost; the kit product's own cost is not what leaves the shelf.
    const kitCosts = await this.db
      .select({
        id: productKits.productId,
        cost: sql<string>`sum(${products.costPrice} * ${productKitComponents.quantity})`,
      })
      .from(productKits)
      .innerJoin(productKitComponents, eq(productKitComponents.kitId, productKits.id))
      .innerJoin(products, eq(products.id, productKitComponents.productId))
      .where(and(inArray(productKits.productId, ids), eq(productKits.isActive, true)))
      .groupBy(productKits.productId);
    const kitCost = new Map(kitCosts.map((k) => [k.id, Number(k.cost)]));
    const groups = new Map<string, string[]>();
    for (const m of memberships)
      groups.set(m.productId, [...(groups.get(m.productId) ?? []), m.groupId]);
    return new Map(
      rows.map((r) => [
        r.id,
        {
          id: r.id,
          costPrice: kitCost.get(r.id) ?? Number(r.cost ?? 0),
          brand: r.brand,
          categoryChain: categoryChain(r.categoryId, parents),
          groupIds: groups.get(r.id) ?? [],
        },
      ]),
    );
  }

  async floorsFor(companyId: string, productIds: string[]): Promise<Map<string, FloorResult>> {
    const [rules, prods] = await Promise.all([
      this.rules(companyId),
      this.floorProducts(companyId, productIds),
    ]);
    return new Map([...prods].map(([id, p]) => [id, resolveFloor(p, rules)]));
  }

  /**
   * Checks a document's lines. A line is below its floor when its net unit price is under the
   * floor (a floor typed into its price list line, else the rule for the product). A line is
   * overridden when it has been taken below the list price, and that is compared with the limit of
   * the person responsible. Neither refuses anything here; the caller decides what to do.
   */
  async assess(
    companyId: string,
    userId: string | null,
    lines: GuardLine[],
  ): Promise<GuardAssessment> {
    const floors = await this.floorsFor(
      companyId,
      lines.map((l) => l.productId),
    );
    const [limit, labels] = await Promise.all([
      this.limitFor(companyId, userId),
      this.ruleLabels(
        companyId,
        [...floors.values()].flatMap((f) => (f.rule ? [f.rule] : [])),
      ),
    ]);

    const traces: GuardTrace[] = [];
    const blocked: string[] = [];
    let largestShortfall = 0;
    let largestOverride = 0;
    let belowAny = false;

    for (const line of lines) {
      const floor = floors.get(line.productId);
      const explicit = line.explicitFloorNet != null && line.explicitFloorNet > 0;
      const floorNet = explicit ? line.explicitFloorNet! : (floor?.floorNet ?? null);
      const kind = explicit ? 'price_list' : floorNet != null ? 'rule' : null;
      const enforcement = explicit ? 'approval' : (floor?.rule?.enforcement ?? null);
      const net = line.netUnit;
      const below = floorNet != null && net != null && net < floorNet - EPSILON;
      const shortfall = below ? shortfallPercent(net, floorNet) : 0;
      const overrideNet = line.overrideNetUnit ?? net;
      const override =
        overrideNet != null && line.listNetUnit != null
          ? reductionPercent(overrideNet, line.listNetUnit)
          : 0;
      traces.push({
        floorNet,
        floorSource: explicit
          ? "The price list line's own floor price"
          : floor?.rule
            ? describeRule(floor.rule, labels)
            : null,
        floorKind: kind,
        belowFloor: below,
        shortfallPercent: shortfall,
        listNetUnit: line.listNetUnit ?? null,
        enforcement,
        overridePercent: override,
        overrideLimitPercent: limit,
        overOverrideLimit: limit != null && override > limit + 0.0001,
      });
      if (below) {
        belowAny = true;
        largestShortfall = Math.max(largestShortfall, shortfall);
        if (enforcement === 'block')
          blocked.push(
            `${line.label ?? 'A line'} is below its price floor of ${floorNet!.toFixed(2)} (before tax).`,
          );
      }
      largestOverride = Math.max(largestOverride, override);
    }
    const overLimit = limit != null && largestOverride > limit + 0.0001;
    return {
      lines: traces,
      belowFloor: belowAny,
      largestShortfallPercent: largestShortfall,
      blocked,
      largestOverridePercent: largestOverride,
      overrideLimitPercent: limit,
      overOverrideLimit: overLimit,
      needsApproval: belowAny || overLimit,
    };
  }

  /** The most this person may take a price below list without approval, or null for no limit. */
  async limitFor(companyId: string, userId: string | null): Promise<number | null> {
    const limits = await this.limits(companyId);
    if (limits.length === 0) return null;
    if (!userId) return limitFor([], limits, false);
    const snap = await this.access.snapshot(userId);
    return limitFor(snap.roleKeys, limits, snap.superAdmin);
  }

  /** Names for the categories and groups a rule points at, for readable explanations. */
  async ruleLabels(companyId: string, rules: FloorRule[]): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const catIds = rules.filter((r) => r.scopeType === 'category').map((r) => r.scopeRef);
    const groupIds = rules.filter((r) => r.scopeType === 'product_group').map((r) => r.scopeRef);
    if (catIds.length > 0) {
      const rows = await this.db
        .select({ id: categories.id, name: categories.name })
        .from(categories)
        .where(inArray(categories.id, catIds));
      for (const r of rows) out[r.id] = r.name;
    }
    if (groupIds.length > 0) {
      const rows = await this.db
        .select({ id: productGroups.id, name: productGroups.name })
        .from(productGroups)
        .where(and(inArray(productGroups.id, groupIds), eq(productGroups.companyId, companyId)));
      for (const r of rows) out[r.id] = r.name;
    }
    return out;
  }
}
