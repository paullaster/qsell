import { and, asc, eq, inArray, isNull } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import { customerGroups, packageAudiences, packageOptions, packageSlots, productKitComponents, productKits, productPackages, products } from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { PricingConfigError } from './config-service';
import type { KitAllocation } from './domain/kits';
import { belowCostWhenCheapest, cheapestSelection, checkPackage, servingPrice, type PackageDef, type PackagePricingMode, type ShortStockMode } from './domain/packages';

type Why = ReasonInput;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export interface PackageOptionView {
  id: string;
  productId: string;
  name: string;
  sku: string;
  quantity: number;
  difference: number;
  /** A fixed price per pick for this package; null means the product's own selling price. */
  ownPrice: number | null;
  isDefault: boolean;
  weight: number | null;
  /** What the product sells for on its own, per base unit. */
  productPrice: number | null;
  cost: number;
  /** Free stock of the product (on hand less reserved). */
  stock: number;
  /** Stock is counted for this product (a service or non-stock item never runs out). */
  managed: boolean;
  /** The product is switched off, deleted or no longer sold, so this option cannot be chosen. */
  unavailable: boolean;
}

export interface PackageSlotView {
  id: string;
  name: string;
  helpText: string;
  minPicks: number;
  maxPicks: number;
  allowRepeats: boolean;
  included: boolean;
  options: PackageOptionView[];
}

/** Who may order and when: all empty means no rule. `groupIds` matter only when `audience` is `groups`. */
export interface PackageRules {
  minServings: number | null;
  maxServings: number | null;
  noticeMinutes: number | null;
  closesDaysBefore: number | null;
  closesAtMinute: number | null;
  weekdays: number[];
  dailyLimit: number | null;
  audience: 'anyone' | 'signed_in' | 'groups';
  groupIds: string[];
  /** Names of the groups, for the screen (read only; ignored when saving). */
  groupLabels?: Record<string, string>;
}

export const NO_RULES: PackageRules = { minServings: null, maxServings: null, noticeMinutes: null, closesDaysBefore: null, closesAtMinute: null, weekdays: [], dailyLimit: null, audience: 'anyone', groupIds: [] };

/** What is wrong with a set of rules, in plain words, or null. The database checks the same things. */
export function rulesProblem(rules: PackageRules): string | null {
  const whole = (n: number | null, least: number): boolean => n === null || (Number.isInteger(n) && n >= least);
  if (!whole(rules.minServings, 1) || !whole(rules.maxServings, 1)) return 'The fewest and most servings must be whole numbers from 1.';
  if (rules.minServings !== null && rules.maxServings !== null && rules.minServings > rules.maxServings) return 'The fewest servings cannot be more than the most.';
  if (!whole(rules.noticeMinutes, 0) || !whole(rules.closesDaysBefore, 0)) return 'Notice and closing days must be whole numbers from 0.';
  if (rules.closesAtMinute !== null && (!Number.isInteger(rules.closesAtMinute) || rules.closesAtMinute < 0 || rules.closesAtMinute >= 1440)) return 'The closing time must be a time of day.';
  if (rules.closesDaysBefore !== null && rules.closesAtMinute === null) return 'Say at what time of day ordering closes.';
  if (!whole(rules.dailyLimit, 1)) return 'The daily limit must be a whole number from 1.';
  if (rules.weekdays.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return 'Days of the week must be from Sunday to Saturday.';
  if (rules.audience === 'groups' && rules.groupIds.length === 0) return 'Choose at least one customer group, or let anyone order.';
  return null;
}

export interface PackageView {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  /** The package product's own price: the base price in base-plus-differences mode. */
  price: number | null;
  pricingMode: PackagePricingMode;
  allocation: KitAllocation;
  shortStockMode: ShortStockMode;
  isActive: boolean;
  version: number;
  slots: PackageSlotView[];
  rules: PackageRules;
  /** The price of the cheapest valid selection (the "from" price), and whether it sells for less than it costs. */
  from: { price: number | null; cost: number; belowCost: boolean };
  /** Options that cannot be chosen now (switched off or deleted). */
  unavailableOptions: number;
}

export interface PackageInput {
  productId: string;
  pricingMode: PackagePricingMode;
  allocation: KitAllocation;
  shortStockMode: ShortStockMode;
  isActive?: boolean;
  /** Left out, the rules stay as they are (a new package starts with none). */
  rules?: PackageRules;
  slots: {
    name: string;
    helpText?: string;
    minPicks: number;
    maxPicks: number;
    allowRepeats?: boolean;
    included?: boolean;
    options: { productId: string; quantity: number; difference?: number; ownPrice?: number | null; isDefault?: boolean; weight?: number | null }[];
  }[];
}

/** The pure shape the rules work on, with each option's own price worked out (a fixed amount, or the product's price times the quantity). */
export function toDefinition(view: Pick<PackageView, 'productId' | 'pricingMode' | 'allocation' | 'slots'>): PackageDef {
  return {
    productId: view.productId,
    pricingMode: view.pricingMode,
    allocation: view.allocation,
    slots: view.slots.map((slot) => ({
      id: slot.id,
      name: slot.name,
      minPicks: slot.minPicks,
      maxPicks: slot.maxPicks,
      allowRepeats: slot.allowRepeats,
      included: slot.included,
      options: slot.options.map((o) => ({
        id: o.id,
        productId: o.productId,
        quantity: o.quantity,
        difference: o.difference,
        price: o.ownPrice ?? (o.productPrice === null ? null : round2(o.productPrice * o.quantity)),
        cost: round2(o.cost * o.quantity),
        weight: o.weight,
        isDefault: o.isDefault,
      })),
    })),
  };
}

const ruleColumns = (rules: PackageRules | undefined) =>
  rules === undefined
    ? {}
    : {
        minServings: rules.minServings,
        maxServings: rules.maxServings,
        noticeMinutes: rules.noticeMinutes,
        closesDaysBefore: rules.closesDaysBefore,
        closesAtMinute: rules.closesAtMinute,
        weekdays: [...new Set(rules.weekdays)].sort((a, b) => a - b),
        dailyLimit: rules.dailyLimit,
        audience: rules.audience,
      };

/** Everything an administrator does with configurable packages. Each change needs a reason and is logged. */
export class PackageConfigService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
  ) {}

  private why(companyId: string, reason: Why) {
    return this.reasons.require(companyId, reason, 'pricing_configuration');
  }

  async list(companyId: string, onlyProductId?: string | readonly string[]): Promise<PackageView[]> {
    const packages = await this.db
      .select()
      .from(productPackages)
      .where(
        onlyProductId === undefined
          ? eq(productPackages.companyId, companyId)
          : and(eq(productPackages.companyId, companyId), typeof onlyProductId === 'string' ? eq(productPackages.productId, onlyProductId) : inArray(productPackages.productId, [...onlyProductId])),
      )
      .orderBy(asc(productPackages.createdAt));
    if (packages.length === 0) return [];
    const packageIds = packages.map((p) => p.id);
    const slots = await this.db.select().from(packageSlots).where(inArray(packageSlots.packageId, packageIds)).orderBy(asc(packageSlots.sortOrder));
    const slotIds = slots.map((s) => s.id);
    const audienceRows = await this.db.select().from(packageAudiences).where(inArray(packageAudiences.packageId, packageIds));
    const groupNames = audienceRows.length === 0 ? [] : await this.db.select({ id: customerGroups.id, name: customerGroups.name }).from(customerGroups).where(inArray(customerGroups.id, [...new Set(audienceRows.map((a) => a.customerGroupId))]));
    const groupName = new Map(groupNames.map((g) => [g.id, g.name]));
    const [packageProducts, options] = await Promise.all([
      this.db
        .select({ id: products.id, name: products.name, sku: products.sku, price: products.price })
        .from(products)
        .where(inArray(products.id, packages.map((p) => p.productId))),
      slotIds.length === 0
        ? Promise.resolve([])
        : this.db
            .select({
              id: packageOptions.id,
              slotId: packageOptions.slotId,
              productId: packageOptions.productId,
              quantity: packageOptions.quantity,
              difference: packageOptions.difference,
              ownPrice: packageOptions.ownPrice,
              isDefault: packageOptions.isDefault,
              weight: packageOptions.weight,
              sortOrder: packageOptions.sortOrder,
              name: products.name,
              sku: products.sku,
              price: products.price,
              cost: products.costPrice,
              stock: products.stockQuantity,
              reserved: products.reservedQuantity,
              kind: products.inventoryKind,
              active: products.isActive,
              sellable: products.isSellable,
              deleted: products.deletedAt,
            })
            .from(packageOptions)
            .innerJoin(products, eq(products.id, packageOptions.productId))
            .where(inArray(packageOptions.slotId, slotIds))
            .orderBy(asc(packageOptions.sortOrder)),
    ]);
    const byProduct = new Map(packageProducts.map((p) => [p.id, p]));
    return packages.map((pkg) => {
      const mySlots = slots.filter((s) => s.packageId === pkg.id).map((slot): PackageSlotView => ({
        id: slot.id,
        name: slot.name,
        helpText: slot.helpText,
        minPicks: slot.minPicks,
        maxPicks: slot.maxPicks,
        allowRepeats: slot.allowRepeats,
        included: slot.included,
        options: options
          .filter((o) => o.slotId === slot.id)
          .map((o): PackageOptionView => ({
            id: o.id,
            productId: o.productId,
            name: o.name,
            sku: o.sku,
            quantity: o.quantity,
            difference: Number(o.difference),
            ownPrice: o.ownPrice === null ? null : Number(o.ownPrice),
            isDefault: o.isDefault,
            weight: o.weight === null ? null : Number(o.weight),
            productPrice: o.price === null ? null : Number(o.price),
            cost: Number(o.cost),
            stock: o.stock - o.reserved,
            managed: o.kind === 'inventory',
            unavailable: o.deleted !== null || !o.active || !o.sellable,
          })),
      }));
      const product = byProduct.get(pkg.productId);
      const price = product?.price === null || product === undefined ? null : Number(product.price);
      const partial = { productId: pkg.productId, pricingMode: pkg.pricingMode, allocation: pkg.allocation, slots: mySlots };
      const def = toDefinition(partial);
      const picks = cheapestSelection(def);
      const cheapest = belowCostWhenCheapest(def, price ?? 0);
      return {
        id: pkg.id,
        productId: pkg.productId,
        productName: product?.name ?? pkg.productId,
        sku: product?.sku ?? '',
        price,
        pricingMode: pkg.pricingMode,
        allocation: pkg.allocation,
        shortStockMode: pkg.shortStockMode,
        isActive: pkg.isActive,
        version: pkg.version,
        rules: {
          minServings: pkg.minServings,
          maxServings: pkg.maxServings,
          noticeMinutes: pkg.noticeMinutes,
          closesDaysBefore: pkg.closesDaysBefore,
          closesAtMinute: pkg.closesAtMinute,
          weekdays: [...pkg.weekdays].sort((a, b) => a - b),
          dailyLimit: pkg.dailyLimit,
          audience: pkg.audience,
          groupIds: audienceRows.filter((a) => a.packageId === pkg.id).map((a) => a.customerGroupId),
          groupLabels: Object.fromEntries(audienceRows.filter((a) => a.packageId === pkg.id).map((a) => [a.customerGroupId, groupName.get(a.customerGroupId) ?? 'Customer group'])),
        },
        slots: mySlots,
        from: { price: servingPrice(def, picks, price ?? 0), cost: cheapest.cost, belowCost: cheapest.below },
        unavailableOptions: mySlots.reduce((n, s) => n + s.options.filter((o) => o.unavailable).length, 0),
      };
    });
  }

  /**
   * Makes a package of a product, or changes the one it already is. The package is sold as the product; the product's own stock is
   * not used. A package cannot be a kit, hold a kit or another package, or be an option of another package.
   */
  async save(companyId: string, input: PackageInput, actor: Actor, reason: Why): Promise<PackageView> {
    const why = await this.why(companyId, reason);
    const [packageProduct] = await this.db
      .select({ id: products.id, name: products.name, isSellable: products.isSellable, price: products.price, soldOnly: products.soldOnlyInPackages })
      .from(products)
      .where(and(eq(products.id, input.productId), isNull(products.deletedAt)))
      .limit(1);
    if (packageProduct === undefined) throw new PricingConfigError('NOT_FOUND', 'That product does not exist.');
    const problems: { path: string; message: string }[] = [];
    if (!packageProduct.isSellable) problems.push({ path: 'productId', message: `${packageProduct.name} is not sold to customers, so it cannot be a package.` });
    if (packageProduct.soldOnly) problems.push({ path: 'productId', message: `${packageProduct.name} is sold only inside packages, so it cannot be a package itself.` });

    const [kitRows, kitPartRows, optionRows, otherPackages] = await Promise.all([
      this.db.select({ productId: productKits.productId }).from(productKits).where(eq(productKits.companyId, companyId)),
      this.db.select({ productId: productKitComponents.productId }).from(productKitComponents).innerJoin(productKits, eq(productKits.id, productKitComponents.kitId)).where(eq(productKits.companyId, companyId)),
      this.db
        .select({ productId: packageOptions.productId, packageProductId: productPackages.productId })
        .from(packageOptions)
        .innerJoin(packageSlots, eq(packageSlots.id, packageOptions.slotId))
        .innerJoin(productPackages, eq(productPackages.id, packageSlots.packageId))
        .where(eq(productPackages.companyId, companyId)),
      this.db.select({ productId: productPackages.productId }).from(productPackages).where(and(eq(productPackages.companyId, companyId))),
    ]);
    if (kitRows.some((k) => k.productId === input.productId)) problems.push({ path: 'productId', message: `${packageProduct.name} is a kit, so it cannot also be a package.` });
    if (kitPartRows.some((k) => k.productId === input.productId)) problems.push({ path: 'productId', message: `${packageProduct.name} is a component of a kit, so it cannot be a package.` });
    if (optionRows.some((o) => o.productId === input.productId && o.packageProductId !== input.productId)) problems.push({ path: 'productId', message: `${packageProduct.name} is an option of another package, so it cannot also be a package.` });
    const kitsAndPackages = new Set([...kitRows.map((k) => k.productId), ...otherPackages.map((p) => p.productId).filter((id) => id !== input.productId)]);

    const optionIds = [...new Set(input.slots.flatMap((s) => s.options.map((o) => o.productId)))];
    const optionProducts = optionIds.length === 0
      ? []
      : await this.db
          .select({ id: products.id, name: products.name, price: products.price, cost: products.costPrice, sellable: products.isSellable })
          .from(products)
          .where(and(inArray(products.id, optionIds), isNull(products.deletedAt)));
    const known = new Map(optionProducts.map((p) => [p.id, p]));
    for (const id of optionIds) {
      const found = known.get(id);
      if (found !== undefined && !found.sellable) problems.push({ path: 'slots', message: `${found.name} is not sold to customers, so a package cannot offer it.` });
    }

    const def: PackageDef = {
      productId: input.productId,
      pricingMode: input.pricingMode,
      allocation: input.allocation,
      slots: input.slots.map((slot, si) => ({
        id: `slot-${String(si)}`,
        name: slot.name,
        minPicks: slot.minPicks,
        maxPicks: slot.maxPicks,
        allowRepeats: slot.allowRepeats === true,
        included: slot.included === true,
        options: slot.options.map((o, oi) => {
          const product = known.get(o.productId);
          const productPrice = product?.price === null || product === undefined ? null : Number(product.price);
          return {
            id: `option-${String(si)}-${String(oi)}`,
            productId: o.productId,
            quantity: o.quantity,
            difference: o.difference ?? 0,
            price: o.ownPrice ?? (productPrice === null ? null : round2(productPrice * o.quantity)),
            cost: round2(Number(product?.cost ?? 0) * o.quantity),
            weight: o.weight ?? null,
            isDefault: o.isDefault === true,
          };
        }),
      })),
    };
    if (!['hide', 'disable', 'substitute'].includes(input.shortStockMode)) problems.push({ path: 'shortStockMode', message: 'Choose what to do with an option that is out of stock.' });
    problems.push(...checkPackage(def, new Set(known.keys()), kitsAndPackages));
    if (input.rules !== undefined) {
      const wrong = rulesProblem(input.rules);
      if (wrong !== null) problems.push({ path: 'rules', message: wrong });
      if (input.rules.audience === 'groups') {
        const found = await this.db.select({ id: customerGroups.id }).from(customerGroups).where(and(eq(customerGroups.companyId, companyId), inArray(customerGroups.id, input.rules.groupIds)));
        if (found.length !== new Set(input.rules.groupIds).size) problems.push({ path: 'rules', message: 'A customer group chosen for this package does not exist.' });
      }
    }
    const first = problems[0];
    if (first !== undefined) throw new PricingConfigError('INVALID', first.message, problems);

    await this.db.transaction(async (tx) => {
      const [before] = await tx.select().from(productPackages).where(eq(productPackages.productId, input.productId)).for('update').limit(1);
      let packageId: string;
      if (before === undefined) {
        const [row] = await tx
          .insert(productPackages)
          .values({ companyId, productId: input.productId, pricingMode: input.pricingMode, allocation: input.allocation, shortStockMode: input.shortStockMode, isActive: input.isActive ?? true, ...ruleColumns(input.rules), createdBy: actor.id ?? 'system' })
          .returning({ id: productPackages.id });
        if (row === undefined) throw new Error('the package was not saved');
        packageId = row.id;
      } else {
        packageId = before.id;
        await tx
          .update(productPackages)
          .set({ pricingMode: input.pricingMode, allocation: input.allocation, shortStockMode: input.shortStockMode, isActive: input.isActive ?? true, ...ruleColumns(input.rules), version: before.version + 1, updatedAt: new Date() })
          .where(eq(productPackages.id, packageId));
        // Slots go with their options. Orders and quotes keep their own copy of what was chosen, so nothing sold is touched.
        await tx.delete(packageSlots).where(eq(packageSlots.packageId, packageId));
      }
      if (input.rules !== undefined) {
        await tx.delete(packageAudiences).where(eq(packageAudiences.packageId, packageId));
        if (input.rules.audience === 'groups') await tx.insert(packageAudiences).values([...new Set(input.rules.groupIds)].map((customerGroupId) => ({ packageId, customerGroupId })));
      }
      for (const [si, slot] of input.slots.entries()) {
        const [row] = await tx
          .insert(packageSlots)
          .values({ packageId, name: slot.name.trim(), helpText: (slot.helpText ?? '').trim(), minPicks: slot.minPicks, maxPicks: slot.maxPicks, allowRepeats: slot.allowRepeats === true, included: slot.included === true, sortOrder: si })
          .returning({ id: packageSlots.id });
        if (row === undefined) throw new Error('a slot was not saved');
        await tx.insert(packageOptions).values(
          slot.options.map((o, oi) => ({
            slotId: row.id,
            productId: o.productId,
            quantity: o.quantity,
            difference: (o.difference ?? 0).toFixed(2),
            ownPrice: o.ownPrice === null || o.ownPrice === undefined ? null : o.ownPrice.toFixed(2),
            isDefault: o.isDefault === true,
            weight: o.weight === null || o.weight === undefined ? null : o.weight.toFixed(4),
            sortOrder: oi,
          })),
        );
      }
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'product_package', id: packageId },
          action: before === undefined ? 'pricing.package_created' : 'pricing.package_changed',
          reason: why,
          inputs: before === undefined ? {} : { pricingMode: before.pricingMode, shortStockMode: before.shortStockMode, isActive: before.isActive, version: before.version },
          outcome: {
            product: packageProduct.name,
            pricingMode: input.pricingMode,
            allocation: input.allocation,
            shortStockMode: input.shortStockMode,
            slots: input.slots.length,
            options: input.slots.reduce((n, s) => n + s.options.length, 0),
            isActive: input.isActive ?? true,
            ...(input.rules === undefined ? {} : { rules: input.rules }),
          },
        },
        tx,
      );
    });
    const [saved] = await this.list(companyId, input.productId);
    if (saved === undefined) throw new Error('the package was not found after saving');
    return saved;
  }

  /** Stops a product being a package. It goes back to being an ordinary product. Orders and quotes already made keep what was chosen. */
  async remove(companyId: string, productId: string, actor: Actor, reason: Why): Promise<void> {
    const why = await this.why(companyId, reason);
    await this.db.transaction(async (tx) => {
      const [row] = await tx.delete(productPackages).where(and(eq(productPackages.companyId, companyId), eq(productPackages.productId, productId))).returning();
      if (row === undefined) throw new PricingConfigError('NOT_FOUND', 'That product is not a package.');
      await this.decisions.record(
        { companyId, actor, subject: { type: 'product_package', id: row.id }, action: 'pricing.package_removed', reason: why, inputs: { productId, pricingMode: row.pricingMode } },
        tx,
      );
    });
  }
}
