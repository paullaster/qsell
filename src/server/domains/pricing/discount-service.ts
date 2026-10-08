import { and, eq, inArray, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  discountCounters,
  discountCoupons,
  discountRules,
  discountUsage,
  products,
} from '@/server/db/drizzle/schema';
import {
  NO_REWARD,
  resolveLineDiscounts,
  resolveOrderDiscounts,
  type AppliedDiscount,
  type Considered,
  type DiscountLine,
  type DiscountRule,
  type RuleAvailability,
} from './domain/discounts';
import { resolveGifts, resolveMixDiscounts } from './domain/mix';
import type { DiscountTrace, PriceTrace } from './domain/types';
import type { PriceGuardService } from './guard-service';
import type { PricingService } from './service';

const TTL_MS = 10_000;
/** Counters are split this many ways so many orders at once do not queue on one row. */
export const COUNTER_SHARDS = 8;

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];
type Writer = Pick<DrizzleDb, 'select' | 'insert' | 'update'>;

export class DiscountLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiscountLimitError';
  }
}

export type DiscountRuleRow = typeof discountRules.$inferSelect;

export const toRule = (r: DiscountRuleRow): DiscountRule => ({
  id: r.id,
  code: r.code,
  name: r.name,
  kind: r.kind,
  priority: r.priority,
  stacking: r.stacking,
  validFrom: r.validFrom,
  validTo: r.validTo,
  schedule: r.schedule ?? {},
  scopes: r.scopes ?? {},
  target: r.target ?? {},
  conditions: r.conditions ?? {},
  reward: r.reward ?? NO_REWARD,
  mix: r.mix ?? null,
  requiresCoupon: r.requiresCoupon,
  limits: r.limits ?? {},
  appliesToContract: r.appliesToContract,
  version: r.version,
});

/** A line the price lists have already priced, as discounts need it. */
export interface PricedItem {
  productId: string;
  quantity: number;
  /** The unit price and line total in the line's own tax basis. */
  unitPrice: number;
  lineTotal: number;
  taxRate: number;
  lineTaxInclusive: boolean;
  /** The line's own floor from its price list, per unit, in the line's basis. */
  explicitFloorUnit?: number | null;
  /** The explanation the price list gave, to tell whether a contract priced it. */
  trace?: Pick<PriceTrace, 'winner'> | null;
}

export interface DiscountSale {
  at?: Date;
  customerId?: string | null;
  branchId?: string | null;
  salesType?: string | null;
  channel?: string | null;
  paymentMethod?: string | null;
}

/** What one rule gave across a whole document: what is recorded as its use. */
export interface RuleApplication {
  ruleId: string;
  ruleVersion: number;
  code: string;
  couponId: string | null;
  couponCode: string | null;
  amount: number;
}

export interface BasketLine {
  index: number;
  lineTotalBefore: number;
  unitPriceBefore: number;
  /** What line rules took off. */
  lineDiscount: number;
  /** What order rules took off (the share spread to this line). */
  orderDiscount: number;
  lineTotalAfter: number;
  unitPriceAfter: number;
  /** Order rules' percentage on this line after line rules, for documents that keep a percentage. */
  orderPercent: number;
  /** Every rule that was looked at, for the simulator. The stored trace keeps only the useful ones. */
  considered: Considered[];
  trace: DiscountTrace;
}

/** A free item a promotion adds to the document. */
export interface GiftLine {
  ruleId: string;
  ruleVersion: number;
  code: string;
  ruleName: string;
  productId: string;
  productName: string;
  sku: string;
  quantity: number;
  /** What the gift would have cost the customer, for the rule's budget. */
  value: number;
  /** What one unit costs you. */
  unitCost: number;
  imageUrl: string;
}

export interface BasketDiscounts {
  lines: BasketLine[];
  /** Free items the basket has earned. */
  gifts: GiftLine[];
  totalDiscount: number;
  applications: RuleApplication[];
  couponProblems: Array<{ code: string; reason: string }>;
  /** What the order rules did, for the document header. */
  orderApplied: AppliedDiscount[];
  orderConsidered: Considered[];
}

type Cached<T> = { at: number; value: T };

const shardOf = (documentId: string) => {
  let h = 0;
  for (let i = 0; i < documentId.length; i++) h = (h * 31 + documentId.charCodeAt(i)) >>> 0;
  return h % COUNTER_SHARDS;
};

/**
 * Applies discount rules to priced lines and records their use. The deciding is done by the pure
 * functions in `domain/discounts`; this class loads what they need (active rules, coupons, how
 * much of each limit is left, floors) and writes the use of a rule when a document is saved.
 */
export class DiscountService {
  private cache = new Map<string, Cached<DiscountRuleRow[]>>();

  constructor(
    private readonly db: DrizzleDb,
    private readonly pricing: Pick<PricingService, 'groupFor'>,
    private readonly guard: Pick<PriceGuardService, 'floorProducts' | 'floorsFor'>,
  ) {}

  invalidate(companyId?: string) {
    if (companyId) this.cache.delete(companyId);
    else this.cache.clear();
  }

  /** Rules that are in force (active, not waiting on an approval). Windows are judged per sale. */
  async activeRules(companyId: string): Promise<DiscountRuleRow[]> {
    const hit = this.cache.get(companyId);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const rows = await this.db
      .select()
      .from(discountRules)
      .where(and(eq(discountRules.companyId, companyId), eq(discountRules.status, 'active')));
    this.cache.set(companyId, { at: Date.now(), value: rows });
    return rows;
  }

  /**
   * Looks coupon codes up. A code unlocks its rule when it is active, in date, and within its
   * own use limits (overall and per customer). A code that cannot be used says why.
   */
  async resolveCoupons(
    companyId: string,
    codes: string[],
    customerId: string | null,
    at: Date,
    extraRules: DiscountRuleRow[] = [],
  ): Promise<{
    unlocked: Map<string, { code: string; couponId: string }>;
    problems: Array<{ code: string; reason: string }>;
  }> {
    const unlocked = new Map<string, { code: string; couponId: string }>();
    const problems: Array<{ code: string; reason: string }> = [];
    const wanted = [...new Set(codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
    if (wanted.length === 0) return { unlocked, problems };
    const rows = await this.db
      .select()
      .from(discountCoupons)
      .where(and(eq(discountCoupons.companyId, companyId), inArray(discountCoupons.code, wanted)));
    const byCode = new Map(rows.map((r) => [r.code, r]));
    const used = await this.couponUse(
      rows.map((r) => r.id),
      customerId,
    );
    const active = new Map(
      [...(await this.activeRules(companyId)), ...extraRules].map((r) => [r.id, r]),
    );
    for (const code of wanted) {
      const c = byCode.get(code);
      if (!c) {
        problems.push({ code, reason: 'That code is not valid.' });
        continue;
      }
      const rule = active.get(c.ruleId);
      if (c.status !== 'active' || !rule) {
        problems.push({ code, reason: 'That code is no longer in use.' });
      } else if (at < c.validFrom) {
        problems.push({ code, reason: 'That code is not valid yet.' });
      } else if (c.validTo && at >= c.validTo) {
        problems.push({ code, reason: 'That code has expired.' });
      } else if (c.maxUses != null && (used.total.get(c.id) ?? 0) >= c.maxUses) {
        problems.push({ code, reason: 'That code has been used the most times it allows.' });
      } else if (
        c.maxUsesPerCustomer != null &&
        customerId &&
        (used.mine.get(c.id) ?? 0) >= c.maxUsesPerCustomer
      ) {
        problems.push({
          code,
          reason: 'You have already used that code the most times it allows.',
        });
      } else {
        unlocked.set(c.ruleId, { code, couponId: c.id });
      }
    }
    return { unlocked, problems };
  }

  private async couponUse(couponIds: string[], customerId: string | null) {
    const total = new Map<string, number>();
    const mine = new Map<string, number>();
    if (couponIds.length === 0) return { total, mine };
    const rows = await this.db
      .select({
        couponId: discountUsage.couponId,
        customerId: discountUsage.customerId,
        n: sql<number>`sum(case when ${discountUsage.kind} = 'use' then 1 else -1 end)::int`,
      })
      .from(discountUsage)
      .where(inArray(discountUsage.couponId, couponIds))
      .groupBy(discountUsage.couponId, discountUsage.customerId);
    for (const r of rows) {
      if (!r.couponId) continue;
      total.set(r.couponId, (total.get(r.couponId) ?? 0) + r.n);
      if (customerId && r.customerId === customerId) mine.set(r.couponId, r.n);
    }
    return { total, mine };
  }

  /** How much of each rule's limits is left, for this customer. */
  async availability(
    rules: DiscountRuleRow[],
    customerId: string | null,
    reader: Pick<DrizzleDb, 'select'> = this.db,
  ): Promise<Map<string, RuleAvailability>> {
    const out = new Map<string, RuleAvailability>();
    const limited = rules.filter(
      (r) =>
        r.limits.maxUses != null || r.limits.budget != null || r.limits.maxUsesPerCustomer != null,
    );
    for (const r of rules) out.set(r.id, { remainingBudget: null });
    if (limited.length === 0) return out;
    const ids = limited.map((r) => r.id);
    const totals = await reader
      .select({
        ruleId: discountCounters.ruleId,
        uses: sql<number>`sum(${discountCounters.uses})::int`,
        amount: sql<string>`sum(${discountCounters.amount})`,
      })
      .from(discountCounters)
      .where(inArray(discountCounters.ruleId, ids))
      .groupBy(discountCounters.ruleId);
    const t = new Map(totals.map((x) => [x.ruleId, { uses: x.uses, amount: Number(x.amount) }]));
    const mine = new Map<string, number>();
    if (customerId && limited.some((r) => r.limits.maxUsesPerCustomer != null)) {
      const rows = await reader
        .select({
          ruleId: discountUsage.ruleId,
          n: sql<number>`sum(case when ${discountUsage.kind} = 'use' then 1 else -1 end)::int`,
        })
        .from(discountUsage)
        .where(and(inArray(discountUsage.ruleId, ids), eq(discountUsage.customerId, customerId)))
        .groupBy(discountUsage.ruleId);
      for (const r of rows) mine.set(r.ruleId, r.n);
    }
    for (const r of limited) {
      const used = t.get(r.id) ?? { uses: 0, amount: 0 };
      const a: RuleAvailability = {
        remainingBudget:
          r.limits.budget != null
            ? Math.max(0, Math.round((r.limits.budget - used.amount) * 100) / 100)
            : null,
      };
      if (r.limits.maxUses != null && used.uses >= r.limits.maxUses)
        a.blocked = `Used up: all ${r.limits.maxUses} uses are taken`;
      else if (r.limits.budget != null && a.remainingBudget === 0)
        a.blocked = `Used up: the budget of ${r.limits.budget} is spent`;
      else if (
        r.limits.maxUsesPerCustomer != null &&
        customerId &&
        (mine.get(r.id) ?? 0) >= r.limits.maxUsesPerCustomer
      )
        a.blocked = `This customer has reached the limit of ${r.limits.maxUsesPerCustomer} uses`;
      out.set(r.id, a);
    }
    return out;
  }

  /**
   * Works out the discounts for a basket the price lists have priced. Reads only. Line rules come
   * first, then order rules on what the lines now come to; nothing goes below a line's floor.
   */
  async evaluate(
    companyId: string,
    sale: DiscountSale,
    items: PricedItem[],
    opts: {
      couponCodes?: string[];
      /** Rules to try as if they were in force (a draft being tested). Used by the simulator only. */
      asIfActive?: DiscountRuleRow[];
      /** Run only one stage: quotes price the lines first, then judge the order on what they cost. */
      stages?: { line?: boolean; order?: boolean };
    } = {},
  ): Promise<BasketDiscounts> {
    const at = sale.at ?? new Date();
    const empty: BasketDiscounts = {
      lines: items.map((i, index) => untouched(index, i)),
      gifts: [],
      totalDiscount: 0,
      applications: [],
      couponProblems: [],
      orderApplied: [],
      orderConsidered: [],
    };
    const live = await this.activeRules(companyId);
    const extra = new Set((opts.asIfActive ?? []).map((r) => r.id));
    const rows = [...live.filter((r) => !extra.has(r.id)), ...(opts.asIfActive ?? [])];
    const { unlocked, problems } = await this.resolveCoupons(
      companyId,
      opts.couponCodes ?? [],
      sale.customerId ?? null,
      at,
      opts.asIfActive ?? [],
    );
    if (rows.length === 0 || items.length === 0) return { ...empty, couponProblems: problems };

    const [products, floors, groupId, availability] = await Promise.all([
      this.guard.floorProducts(
        companyId,
        items.map((i) => i.productId),
      ),
      this.guard.floorsFor(
        companyId,
        items.map((i) => i.productId),
      ),
      this.pricing.groupFor(companyId, sale.customerId),
      this.availability(rows, sale.customerId ?? null),
    ]);

    const lines: DiscountLine[] = items.map((i, index) => {
      const p = products.get(i.productId);
      const ruleFloor = floors.get(i.productId)?.floorNet ?? null;
      const factor = i.lineTaxInclusive ? 1 + Math.max(0, i.taxRate) / 100 : 1;
      const fromRule = ruleFloor == null ? null : ruleFloor * factor * i.quantity;
      const fromList =
        i.explicitFloorUnit != null && i.explicitFloorUnit > 0
          ? i.explicitFloorUnit * i.quantity
          : null;
      // The strictest floor wins.
      const min =
        fromRule == null ? fromList : fromList == null ? fromRule : Math.max(fromRule, fromList);
      return {
        index,
        id: i.productId,
        brand: p?.brand ?? null,
        categoryChain: p?.categoryChain ?? [],
        groupIds: p?.groupIds ?? [],
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        lineTotal: i.lineTotal,
        minLineTotal: min == null ? null : Math.round(min * 100) / 100,
        contractPriced: i.trace?.winner?.listKind === 'contract',
      };
    });

    const inputs = {
      rules: rows.map(toRule),
      unlockedByCoupon: new Map([...unlocked].map(([ruleId, c]) => [ruleId, c.code])),
      availability,
      ctx: {
        at,
        customerId: sale.customerId ?? null,
        customerGroupId: groupId,
        branchId: sale.branchId ?? null,
        salesType: sale.salesType ?? null,
        channel: sale.channel ?? null,
        paymentMethod: sale.paymentMethod ?? null,
      },
    };

    const lineResults =
      opts.stages?.line === false
        ? lines.map((l) => ({ index: l.index, applied: [], total: 0, trimmed: 0, considered: [] }))
        : resolveLineDiscounts(lines, inputs);
    // Mix deals (buy-and-get, mix-and-match, bundle deals) work on units, on what the line rules left.
    const afterLineRules = lines.map((l, i) => ({
      ...l,
      lineTotal: round(l.lineTotal - lineResults[i]!.total),
    }));
    const mixResult =
      opts.stages?.line === false
        ? {
            lines: new Map<
              number,
              { applied: AppliedDiscount[]; total: number; trimmed: number }
            >(),
            considered: [] as Considered[],
          }
        : resolveMixDiscounts(afterLineRules, inputs);
    for (const [index, m] of mixResult.lines) {
      const lr = lineResults[index]!;
      lr.applied = [...lr.applied, ...m.applied];
      lr.total = round(lr.total + m.total);
      lr.trimmed = round(lr.trimmed + m.trimmed);
    }
    const afterLine = lines.map((l, i) => ({
      ...l,
      lineTotal: round(l.lineTotal - lineResults[i]!.total),
    }));
    // Floors for the order stage count what is already off.
    const orderResult =
      opts.stages?.order === false
        ? {
            applied: [],
            total: 0,
            trimmed: 0,
            linePercent: new Map<number, number>(),
            considered: [],
          }
        : resolveOrderDiscounts(afterLine, inputs);

    // Gifts are judged on what the customer finally pays.
    let giftResult: { gifts: GiftLine[]; considered: Considered[] } = { gifts: [], considered: [] };
    if (opts.stages?.order !== false) {
      const finalLines = afterLine.map((l) => {
        const pct = orderResult.linePercent.get(l.index) ?? 0;
        return { ...l, lineTotal: round(l.lineTotal * (1 - pct / 100)) };
      });
      giftResult = await this.giftLines(rows, finalLines, inputs, availability);
    }

    const byRule = new Map<string, RuleApplication>();
    const note = (a: AppliedDiscount) => {
      const rule = rows.find((r) => r.id === a.ruleId)!;
      const coupon = unlocked.get(a.ruleId);
      const cur = byRule.get(a.ruleId);
      byRule.set(a.ruleId, {
        ruleId: a.ruleId,
        ruleVersion: rule.version,
        code: a.code,
        couponId: coupon?.couponId ?? null,
        couponCode: coupon?.code ?? null,
        amount: round((cur?.amount ?? 0) + a.amount),
      });
    };

    const basket: BasketLine[] = items.map((item, index) => {
      const lr = lineResults[index]!;
      const pct = orderResult.linePercent.get(index) ?? 0;
      const afterLines = round(item.lineTotal - lr.total);
      const orderShare = round((afterLines * pct) / 100);
      const after = round(afterLines - orderShare);
      lr.applied.forEach(note);
      const orderApplied =
        orderResult.applied.length > 0 && orderShare > 0
          ? orderResult.applied.map((a) => ({
              ...a,
              // The line's share of this rule, in proportion to its share of the order discount.
              amount:
                orderResult.total > 0
                  ? round((a.amount * orderShare) / sumShares(orderResult, afterLine, index))
                  : 0,
            }))
          : [];
      return {
        index,
        lineTotalBefore: item.lineTotal,
        unitPriceBefore: item.unitPrice,
        lineDiscount: lr.total,
        orderDiscount: orderShare,
        lineTotalAfter: after,
        unitPriceAfter: item.quantity > 0 ? round(after / item.quantity, 4) : item.unitPrice,
        orderPercent: pct,
        considered: lr.considered,
        trace: {
          unitPriceBefore: item.unitPrice,
          lineTotalBefore: item.lineTotal,
          applied: [
            ...lr.applied.map((a) => ({ ...a, level: 'line' as const })),
            ...orderApplied.map((a) => ({ ...a, level: 'order' as const })),
          ],
          trimmed: lr.trimmed,
          considered: worthKeeping(lr.considered).map((c) => ({
            code: c.code,
            outcome: c.outcome,
            why: c.why,
          })),
        },
      };
    });
    orderResult.applied.forEach(note);
    // A gift counts as a use of its rule, worth what the gift would have cost.
    for (const g of giftResult.gifts) {
      const rule = rows.find((r) => r.id === g.ruleId)!;
      const coupon = unlocked.get(g.ruleId);
      const cur = byRule.get(g.ruleId);
      byRule.set(g.ruleId, {
        ruleId: g.ruleId,
        ruleVersion: rule.version,
        code: g.code,
        couponId: coupon?.couponId ?? null,
        couponCode: coupon?.code ?? null,
        amount: round((cur?.amount ?? 0) + g.value),
      });
    }

    return {
      lines: basket,
      totalDiscount: round(basket.reduce((n, l) => n + l.lineDiscount + l.orderDiscount, 0)),
      applications: [...byRule.values()],
      couponProblems: problems,
      orderApplied: orderResult.applied,
      orderConsidered: [
        ...orderResult.considered,
        ...mixResult.considered,
        ...giftResult.considered,
      ],
      gifts: giftResult.gifts,
    };
  }

  /**
   * The free items the basket has earned, checked against stock and the rule's budget. A gift
   * that is not available is left out, and the reason is kept.
   */
  private async giftLines(
    rows: DiscountRuleRow[],
    lines: DiscountLine[],
    inputs: Parameters<typeof resolveGifts>[1],
    availability: Map<string, RuleAvailability>,
  ): Promise<{ gifts: GiftLine[]; considered: Considered[] }> {
    const { gifts: earned, considered } = resolveGifts(lines, inputs);
    if (earned.length === 0) return { gifts: [], considered };
    const ids = [...new Set(earned.flatMap((e) => e.gifts.map((g) => g.productId)))];
    const found = await this.db
      .select({
        id: products.id,
        name: products.name,
        sku: products.sku,
        price: products.price,
        cost: products.costPrice,
        active: products.isActive,
        deleted: products.deletedAt,
        stock: products.stockQuantity,
        reserved: products.reservedQuantity,
        image: products.imageUrl,
      })
      .from(products)
      .where(inArray(products.id, ids));
    const byId = new Map(found.map((p) => [p.id, p]));
    const out: GiftLine[] = [];
    for (const e of earned) {
      const rule = rows.find((r) => r.id === e.ruleId)!;
      const mine: GiftLine[] = [];
      let skipped: string | null = null;
      for (const g of e.gifts) {
        const p = byId.get(g.productId);
        if (!p || p.deleted != null || !p.active) {
          skipped = `The gift (${p?.name ?? g.productId}) is no longer available`;
          break;
        }
        if (p.stock - p.reserved < g.quantity) {
          skipped = `The gift (${p.name}) is out of stock`;
          break;
        }
        const unit = p.price != null ? Number(p.price) : Number(p.cost);
        mine.push({
          ruleId: e.ruleId,
          ruleVersion: rule.version,
          code: e.code,
          ruleName: e.name,
          productId: p.id,
          productName: p.name,
          sku: p.sku,
          quantity: g.quantity,
          value: round(unit * g.quantity),
          unitCost: Number(p.cost ?? 0),
          imageUrl: p.image,
        });
      }
      const worth = round(mine.reduce((n, g) => n + g.value, 0));
      const budget = availability.get(e.ruleId)?.remainingBudget ?? null;
      if (!skipped && budget != null && worth > budget)
        skipped = 'Its budget does not cover the gift';
      if (skipped) {
        const c = considered.find((x) => x.ruleId === e.ruleId);
        if (c) {
          c.outcome = 'not_applicable';
          c.why = skipped;
        }
        continue;
      }
      out.push(...mine);
    }
    return { gifts: out, considered };
  }

  /**
   * Records the use of rules by a document, in the caller's transaction. One use per rule per
   * document, so saving twice does nothing. Rules marked strict are checked again under a lock, so
   * their limits hold exactly; others may overshoot by a little when many orders land at once.
   */
  async commit(
    tx: Tx,
    companyId: string,
    doc: { type: string; id: string; customerId: string | null },
    applications: RuleApplication[],
  ): Promise<void> {
    const wanted = applications.filter((a) => a.amount > 0);
    if (wanted.length === 0) return;
    const rows = await tx
      .select()
      .from(discountRules)
      .where(
        inArray(
          discountRules.id,
          wanted.map((a) => a.ruleId),
        ),
      )
      .orderBy(discountRules.id);
    const strict = rows.filter((r) => r.strictLimits);
    if (strict.length > 0) {
      // Taken in a fixed order so two orders cannot wait on each other.
      await tx
        .select({ id: discountRules.id })
        .from(discountRules)
        .where(
          inArray(
            discountRules.id,
            strict.map((r) => r.id),
          ),
        )
        .orderBy(discountRules.id)
        .for('update');
      const avail = await this.availability(strict, doc.customerId, tx);
      for (const r of strict) {
        const a = avail.get(r.id);
        const mine = wanted.find((w) => w.ruleId === r.id)!;
        if (a?.blocked)
          throw new DiscountLimitError(
            `${r.name} is no longer available. ${a.blocked}. Please price it again.`,
          );
        if (a?.remainingBudget != null && mine.amount > a.remainingBudget + 0.005)
          throw new DiscountLimitError(
            `${r.name} has only ${a.remainingBudget} left in its budget. Please price it again.`,
          );
      }
    }
    for (const a of wanted) {
      const inserted = await tx
        .insert(discountUsage)
        .values({
          companyId,
          ruleId: a.ruleId,
          ruleVersion: a.ruleVersion,
          couponId: a.couponId,
          couponCode: a.couponCode,
          customerId: doc.customerId,
          documentType: doc.type,
          documentId: doc.id,
          kind: 'use',
          amount: a.amount.toFixed(2),
        })
        .onConflictDoNothing()
        .returning({ id: discountUsage.id });
      if (inserted.length === 0) continue;
      await this.bump(tx, a.ruleId, doc.id, 1, a.amount);
    }
  }

  /** Gives back what a cancelled document used: a reversal for each use, and the counters follow. */
  async reverse(tx: Tx, doc: { type: string; id: string }): Promise<number> {
    const used = await tx
      .select()
      .from(discountUsage)
      .where(
        and(
          eq(discountUsage.documentType, doc.type),
          eq(discountUsage.documentId, doc.id),
          eq(discountUsage.kind, 'use'),
        ),
      );
    let n = 0;
    for (const u of used) {
      const inserted = await tx
        .insert(discountUsage)
        .values({
          companyId: u.companyId,
          ruleId: u.ruleId,
          ruleVersion: u.ruleVersion,
          couponId: u.couponId,
          couponCode: u.couponCode,
          customerId: u.customerId,
          documentType: u.documentType,
          documentId: u.documentId,
          kind: 'reversal',
          amount: (-Number(u.amount)).toFixed(2),
        })
        .onConflictDoNothing()
        .returning({ id: discountUsage.id });
      if (inserted.length === 0) continue;
      await this.bump(tx, u.ruleId, doc.id, -1, -Number(u.amount));
      n++;
    }
    return n;
  }

  private async bump(tx: Writer, ruleId: string, documentId: string, uses: number, amount: number) {
    await tx
      .insert(discountCounters)
      .values({ ruleId, shard: shardOf(documentId), uses, amount: amount.toFixed(2) })
      .onConflictDoUpdate({
        target: [discountCounters.ruleId, discountCounters.shard],
        set: {
          uses: sql`${discountCounters.uses} + ${uses}`,
          amount: sql`${discountCounters.amount} + ${amount.toFixed(2)}::numeric`,
        },
      });
  }
}

const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

/** Most "why" entries a line's stored explanation carries, however many rules there are. */
const MAX_KEPT = 15;

/**
 * What belongs in a line's stored explanation: the rules that applied, lost to another, were used
 * up, or nearly applied (they need a coupon or more units). Rules that were never about this
 * product, customer or day say nothing worth keeping, and a company may have hundreds of them.
 */
export function worthKeeping(considered: Considered[]): Considered[] {
  return considered
    .filter(
      (c) =>
        c.outcome === 'applied' ||
        c.outcome === 'lost' ||
        c.outcome === 'blocked' ||
        c.why.startsWith('Needs') ||
        c.why.includes('contract price'),
    )
    .slice(0, MAX_KEPT);
}

function untouched(index: number, i: PricedItem): BasketLine {
  return {
    index,
    lineTotalBefore: i.lineTotal,
    unitPriceBefore: i.unitPrice,
    lineDiscount: 0,
    orderDiscount: 0,
    lineTotalAfter: i.lineTotal,
    unitPriceAfter: i.unitPrice,
    orderPercent: 0,
    considered: [],
    trace: {
      unitPriceBefore: i.unitPrice,
      lineTotalBefore: i.lineTotal,
      applied: [],
      trimmed: 0,
      considered: [],
    },
  };
}

/** The sum of every line's share of the order discount, to split each rule's amount between lines. */
function sumShares(
  order: { linePercent: Map<number, number> },
  afterLine: Array<{ index: number; lineTotal: number }>,
  _index: number,
): number {
  let sum = 0;
  for (const l of afterLine) sum += (l.lineTotal * (order.linePercent.get(l.index) ?? 0)) / 100;
  return sum || 1;
}
