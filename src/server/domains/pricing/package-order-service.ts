import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { orders, packageInstancePicks, packageInstances, productPackages, products } from '@/server/db/drizzle/schema';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { canonicalSelection, orderingProblem, packageComponentDefs, servingCost, type CanonicalPick, type LocalMoment, type OrderingRules, type RawPick } from './domain/packages';
import { checkPackageBasket, type PackageLineInput, type ShopPackage } from './domain/package-shop';
import type { Kit, KitComponent } from './kit-service';
import type { PackageShopService } from './package-shop-service';
import { toDefinition, type PackageView } from './package-service';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

/** A package line of an order as the caller states it: ids and counts only. */
export interface PackageOrderLine {
  productId: string;
  picks: RawPick[];
  servings: number;
}

export interface OrderContext {
  companyId: string;
  /** The customer's group, when they have one (for packages limited to groups). */
  customerGroupId: string | null;
  /** The buyer is a known, signed-in customer. */
  signedIn: boolean;
  /** The delivery or collection date the order is for (`YYYY-MM-DD`), when it has one. */
  forDate: string | null;
  now: Date;
  /** A preview (the basket's total, a delivery quote) checks the choices and stock but leaves the audience and ordering rules to the order itself. */
  previewOnly?: boolean;
}

/** One package line ready to be priced, split into parts and recorded. */
export interface PreparedPackage {
  /** Position in the order's lines. */
  index: number;
  productId: string;
  name: string;
  version: number;
  servings: number;
  key: string;
  /** Base-plus-differences: what the choices add to the base price for one serving. Summed: null. */
  addedPerServing: number | null;
  /** Summed: the price of one serving. Base-plus-differences: null. */
  summedPerServing: number | null;
  /** What one serving costs the business, for the floor on the choice actually made. */
  costPerServing: number;
  /** The chosen parts as a kit of this line, under a made-up id so two lines of one package never meet. */
  kit: Kit;
  picks: { slotName: string; optionId: string; productId: string; name: string; count: number; quantity: number }[];
  forDate: string | null;
}

export type Prepared = { ok: true; lines: PreparedPackage[] } | { ok: false; error: string; code: 'not_for_sale' | 'package_rule' | 'out_of_stock' | 'package_choice' };

export class PackageRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PackageRuleError';
  }
}

const rulesOf = (view: PackageView): OrderingRules => ({
  minServings: view.rules.minServings,
  maxServings: view.rules.maxServings,
  noticeMinutes: view.rules.noticeMinutes,
  closesDaysBefore: view.rules.closesDaysBefore,
  closesAtMinute: view.rules.closesAtMinute,
  weekdays: view.rules.weekdays,
  dailyLimit: view.rules.dailyLimit,
});

/** The date and minute of day in the company's time zone. */
export function localMoment(now: Date): LocalMoment {
  const date = businessDate(now);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Nairobi', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  return { date, minute: hour * 60 + minute };
}

const needsDate = (rules: OrderingRules): boolean => rules.noticeMinutes !== null || rules.closesDaysBefore !== null || rules.weekdays.length > 0 || rules.dailyLimit !== null;

/**
 * Package lines of an order: checks them against the package as it is now, the audience and the rules of ordering, works out what
 * each is worth, and records the exact selection with the order. The line is then split over its parts exactly like a kit's.
 */
export class PackageOrderService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly shop: PackageShopService,
  ) {}

  /** How many servings of this package are promised for a date by orders that still stand. */
  private async promised(db: DrizzleDb | Tx, companyId: string, productId: string, forDate: string): Promise<number> {
    const [row] = await db
      .select({ n: sql<string>`coalesce(sum(${packageInstances.servings}), 0)` })
      .from(packageInstances)
      .innerJoin(orders, and(eq(orders.id, packageInstances.documentId), eq(packageInstances.documentType, 'order')))
      .where(and(eq(packageInstances.companyId, companyId), eq(packageInstances.packageProductId, productId), eq(packageInstances.forDate, forDate), ne(orders.status, 'cancelled')));
    return Number(row?.n ?? 0);
  }

  async prepare(ctx: OrderContext, lines: readonly (PackageOrderLine & { index: number })[]): Promise<Prepared> {
    if (lines.length === 0) return { ok: true, lines: [] };
    const { packages, stock, views } = await this.shop.load(ctx.companyId, lines.map((l) => l.productId));
    const inputs: PackageLineInput[] = lines.map(({ productId, picks, servings }) => ({ productId, picks, servings }));
    const checks = checkPackageBasket(packages, inputs, stock);
    if (ctx.forDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(ctx.forDate)) return { ok: false, error: 'The date for this order is not a valid date.', code: 'package_rule' };
    const now = localMoment(ctx.now);
    const fulfilment: LocalMoment | null = ctx.forDate === null ? null : { date: ctx.forDate, minute: 0 };
    const partIds = [...new Set([...packages.values()].flatMap((p) => p.slots.flatMap((s) => s.options.map((o) => o.productId))))];
    const parts = partIds.length === 0 ? [] : await this.db.select({ id: products.id, name: products.name, sku: products.sku, taxRate: products.taxRate, inclusive: products.isTaxInclusive, image: products.imageUrl }).from(products).where(inArray(products.id, partIds));
    const partById = new Map(parts.map((p) => [p.id, p]));
    const servingsByPackage = new Map<string, number>();
    const prepared: PreparedPackage[] = [];

    for (const [n, line] of lines.entries()) {
      const pkg: ShopPackage | undefined = packages.get(line.productId);
      const view = views.get(line.productId);
      const check = checks[n];
      if (pkg === undefined || view === undefined || check === undefined) return { ok: false, error: 'A package in your order is not available any more.', code: 'not_for_sale' };
      if (!check.ok) return { ok: false, error: check.problems.join(' '), code: check.problems.some((p) => /sold out/i.test(p)) ? 'out_of_stock' : 'package_choice' };

      const preview = ctx.previewOnly === true;
      // Who may order.
      const { audience, groupIds } = view.rules;
      if (!preview && audience === 'signed_in' && !ctx.signedIn) return { ok: false, error: `${pkg.name} can be ordered only by signed-in customers. Please sign in.`, code: 'package_rule' };
      if (!preview && audience === 'groups' && (ctx.customerGroupId === null || !groupIds.includes(ctx.customerGroupId))) return { ok: false, error: `${pkg.name} is not available for your account.`, code: 'package_rule' };

      // When and how much.
      const rules = rulesOf(view);
      const total = (servingsByPackage.get(line.productId) ?? 0) + line.servings;
      servingsByPackage.set(line.productId, total);
      if (!preview && needsDate(rules) && fulfilment === null) return { ok: false, error: `${pkg.name}: choose the date you need it (a delivery date).`, code: 'package_rule' };
      const already = fulfilment === null || rules.dailyLimit === null ? 0 : await this.promised(this.db, ctx.companyId, line.productId, fulfilment.date);
      const problem = preview ? null : orderingProblem(rules, now, fulfilment, total, already);
      if (problem !== null) return { ok: false, error: `${pkg.name}: ${problem}`, code: 'package_rule' };

      const selection = canonicalSelection(toDefinition(view), line.picks);
      if (!selection.ok) return { ok: false, error: selection.problems[0]?.message ?? 'Please check your choices.', code: 'package_choice' };
      const picks: readonly CanonicalPick[] = selection.picks;
      const components: KitComponent[] = packageComponentDefs(picks).map((c) => {
        const part = partById.get(c.productId);
        return { ...c, name: part?.name ?? 'Part', sku: part?.sku ?? '', taxRate: Number(part?.taxRate ?? 0), isTaxInclusive: part?.inclusive !== false, imageUrl: part?.image ?? '', unavailable: part === undefined };
      });
      const extra = picks.reduce((sum, p) => sum + p.option.difference * p.count, 0);
      prepared.push({
        index: line.index,
        productId: pkg.productId,
        name: pkg.name,
        version: pkg.version,
        servings: line.servings,
        key: check.key,
        addedPerServing: pkg.pricingMode === 'summed' ? null : Math.round((extra + Number.EPSILON) * 100) / 100,
        summedPerServing: pkg.pricingMode === 'summed' ? check.servingPrice : null,
        costPerServing: servingCost(picks),
        kit: { id: `package:${String(line.index)}`, productId: `package:${String(line.index)}`, allocation: view.allocation, components },
        picks: picks.map((p) => ({ slotName: pkg.slots.find((s) => s.id === p.slotId)?.name ?? '', optionId: p.optionId, productId: p.option.productId, name: pkg.slots.flatMap((s) => s.options).find((o) => o.id === p.optionId)?.name ?? '', count: p.count, quantity: p.option.quantity })),
        forDate: ctx.forDate,
      });
    }
    return { ok: true, lines: prepared };
  }

  /**
   * Inside the order's transaction: takes the package rows in a fixed order (so two orders for the last servings of a day queue
   * instead of both passing), counts what is promised for the date, checks the rules once more, and writes the selections.
   */
  async record(tx: Tx, ctx: OrderContext, orderId: string, lines: readonly PreparedPackage[]): Promise<void> {
    if (lines.length === 0) return;
    const productIds = [...new Set(lines.map((l) => l.productId))].sort();
    const rows = await tx.select().from(productPackages).where(and(eq(productPackages.companyId, ctx.companyId), inArray(productPackages.productId, productIds))).orderBy(productPackages.id).for('update');
    const byProduct = new Map(rows.map((r) => [r.productId, r]));
    const now = localMoment(ctx.now);
    const totals = new Map<string, number>();
    for (const line of lines) totals.set(line.productId, (totals.get(line.productId) ?? 0) + line.servings);
    for (const [productId, servings] of totals) {
      const row = byProduct.get(productId);
      if (row?.isActive !== true) throw new PackageRuleError('A package in your order is not available any more.');
      const rules: OrderingRules = { minServings: row.minServings, maxServings: row.maxServings, noticeMinutes: row.noticeMinutes, closesDaysBefore: row.closesDaysBefore, closesAtMinute: row.closesAtMinute, weekdays: row.weekdays, dailyLimit: row.dailyLimit };
      const fulfilment: LocalMoment | null = ctx.forDate === null ? null : { date: ctx.forDate, minute: 0 };
      const already = fulfilment === null || rules.dailyLimit === null ? 0 : await this.promised(tx, ctx.companyId, productId, fulfilment.date);
      const problem = orderingProblem(rules, now, fulfilment, servings, already);
      if (problem !== null) throw new PackageRuleError(`${lines.find((l) => l.productId === productId)?.name ?? 'This package'}: ${problem}`);
    }
    for (const [i, line] of lines.entries()) {
      const [instance] = await tx
        .insert(packageInstances)
        .values({
          companyId: ctx.companyId,
          documentType: 'order',
          documentId: orderId,
          lineNo: i + 1,
          packageProductId: line.productId,
          packageName: line.name,
          packageVersion: line.version,
          servings: line.servings,
          servingPrice: ((line.addedPerServing ?? 0) + (line.summedPerServing ?? 0)).toFixed(2),
          lineTotal: '0',
          selectionKey: line.key,
          forDate: line.forDate,
        })
        .returning({ id: packageInstances.id });
      if (instance === undefined) throw new Error('a package selection was not saved');
      await tx.insert(packageInstancePicks).values(line.picks.map((p, n) => ({ instanceId: instance.id, slotName: p.slotName, productId: p.productId, productName: p.name, count: p.count, quantity: p.quantity, sortOrder: n })));
    }
  }

  /** Writes the final price of each line (after discounts) on its instance. */
  async priceInstances(tx: Tx, orderId: string, totals: readonly { lineNo: number; servingPrice: number; lineTotal: number }[]): Promise<void> {
    for (const t of totals) {
      await tx.update(packageInstances).set({ servingPrice: t.servingPrice.toFixed(2), lineTotal: t.lineTotal.toFixed(2) }).where(and(eq(packageInstances.documentType, 'order'), eq(packageInstances.documentId, orderId), eq(packageInstances.lineNo, t.lineNo)));
    }
  }
}
