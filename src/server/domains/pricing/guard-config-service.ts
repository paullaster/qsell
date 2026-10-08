import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  categories,
  priceFloorRules,
  priceOverrideLimits,
  productGroupMembers,
  productGroups,
  products,
  roles,
} from '@/server/db/drizzle/schema';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { categoryChain } from '@/server/domains/catalog/category-tree';
import { describeRule, resolveFloor } from './domain/floor';
import { FLOOR_SCOPE_TYPES, type FloorEnforcement, type FloorScopeType } from './domain/types';
import { PricingConfigError } from './config-service';
import type { PriceGuardService } from './guard-service';

type Why = ReasonInput;
/** Most products one request may add to or remove from a group. */
export const MAX_GROUP_CHANGE = 5000;
const MAX_MARKUP = 1000;

export interface FloorRuleView {
  id: string;
  scopeType: FloorScopeType;
  scopeRef: string;
  /** What the rule is about, in words: a category's path, a group's name, a product's name. */
  scopeLabel: string;
  markupPercent: number;
  enforcement: FloorEnforcement;
  isActive: boolean;
  version: number;
  updatedAt: string;
}

export interface FloorExplanation {
  product: {
    id: string;
    sku: string;
    name: string;
    cost: number;
    brand: string | null;
    category: string;
  };
  /** The lowest net unit price, or null. */
  floorNet: number | null;
  /** Plain-language answer. */
  summary: string;
  /** Every rule that could apply, strongest first, with what happened to it. */
  considered: Array<{
    label: string;
    markupPercent: number;
    floorNet: number | null;
    used: boolean;
    why: string;
  }>;
}

/**
 * Everything an administrator sets for price floors, override limits and the product groups the
 * floors can be attached to. Each change needs a reason and is written to the decision log.
 */
export class PriceGuardConfigService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly guard: PriceGuardService,
  ) {}

  private why(companyId: string, reason: Why) {
    return this.reasons.require(companyId, reason, 'pricing_configuration');
  }

  // ── Floor rules ──────────────────────────────────────────────────────────

  async listFloorRules(companyId: string): Promise<FloorRuleView[]> {
    const rows = await this.db
      .select()
      .from(priceFloorRules)
      .where(eq(priceFloorRules.companyId, companyId))
      .orderBy(asc(priceFloorRules.scopeType), desc(priceFloorRules.updatedAt));
    const labels = await this.labelsFor(
      companyId,
      rows.map((r) => ({ scopeType: r.scopeType, scopeRef: r.scopeRef })),
    );
    return rows.map((r) => ({
      id: r.id,
      scopeType: r.scopeType,
      scopeRef: r.scopeRef,
      scopeLabel: labels[`${r.scopeType}:${r.scopeRef}`] ?? r.scopeRef,
      markupPercent: Number(r.markupPercent),
      enforcement: r.enforcement,
      isActive: r.isActive,
      version: r.version,
      updatedAt: r.updatedAt.toISOString(),
    }));
  }

  /** Sets the rule for a scope: adds it, or changes the one already there. */
  async setFloorRule(
    companyId: string,
    input: {
      scopeType: FloorScopeType;
      scopeRef?: string;
      markupPercent: number;
      enforcement?: FloorEnforcement;
      isActive?: boolean;
    },
    actor: Actor,
    reason: Why,
  ): Promise<FloorRuleView> {
    const why = await this.why(companyId, reason);
    if (!FLOOR_SCOPE_TYPES.includes(input.scopeType))
      throw new PricingConfigError('INVALID', 'Choose what the floor applies to.');
    const scopeRef = input.scopeType === 'default' ? '' : (input.scopeRef ?? '').trim();
    if (input.scopeType !== 'default' && !scopeRef)
      throw new PricingConfigError('INVALID', 'Choose which product, group, brand or category.');
    if (
      !Number.isFinite(input.markupPercent) ||
      input.markupPercent < 0 ||
      input.markupPercent > MAX_MARKUP
    )
      throw new PricingConfigError(
        'INVALID',
        `The markup over cost must be between 0 and ${MAX_MARKUP}%.`,
      );
    const enforcement = input.enforcement ?? 'approval';
    if (enforcement !== 'approval' && enforcement !== 'block')
      throw new PricingConfigError('INVALID', 'Choose "needs approval" or "refuse the sale".');
    await this.assertScopeExists(companyId, input.scopeType, scopeRef);

    const id = await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(priceFloorRules)
        .where(
          and(
            eq(priceFloorRules.companyId, companyId),
            eq(priceFloorRules.scopeType, input.scopeType),
            eq(priceFloorRules.scopeRef, scopeRef),
          ),
        )
        .for('update')
        .limit(1);
      const values = {
        markupPercent: input.markupPercent.toFixed(3),
        enforcement,
        isActive: input.isActive ?? true,
      };
      let saved: typeof before;
      if (before) {
        [saved] = await tx
          .update(priceFloorRules)
          .set({ ...values, version: before.version + 1, updatedAt: new Date() })
          .where(eq(priceFloorRules.id, before.id))
          .returning();
      } else {
        [saved] = await tx
          .insert(priceFloorRules)
          .values({
            companyId,
            scopeType: input.scopeType,
            scopeRef,
            ...values,
            createdBy: actor.id ?? 'system',
          })
          .returning();
      }
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_floor_rule', id: saved!.id },
          action: before ? 'pricing.floor_changed' : 'pricing.floor_created',
          reason: why,
          inputs: before
            ? {
                markupPercent: Number(before.markupPercent),
                enforcement: before.enforcement,
                isActive: before.isActive,
              }
            : { scopeType: input.scopeType, scopeRef },
          outcome: {
            scopeType: input.scopeType,
            scopeRef,
            markupPercent: input.markupPercent,
            enforcement,
            isActive: values.isActive,
          },
        },
        tx,
      );
      return saved!.id;
    });
    this.guard.invalidate(companyId);
    const view = (await this.listFloorRules(companyId)).find((r) => r.id === id);
    return view!;
  }

  async removeFloorRule(companyId: string, id: string, actor: Actor, reason: Why) {
    const why = await this.why(companyId, reason);
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(priceFloorRules)
        .where(and(eq(priceFloorRules.companyId, companyId), eq(priceFloorRules.id, id)))
        .returning();
      if (!row) throw new PricingConfigError('NOT_FOUND', 'That floor rule does not exist.');
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_floor_rule', id },
          action: 'pricing.floor_removed',
          reason: why,
          inputs: {
            scopeType: row.scopeType,
            scopeRef: row.scopeRef,
            markupPercent: Number(row.markupPercent),
            enforcement: row.enforcement,
          },
        },
        tx,
      );
    });
    this.guard.invalidate(companyId);
  }

  /** Why a product's floor is what it is: every rule that could apply, and which one won. */
  async explainFloor(companyId: string, productId: string): Promise<FloorExplanation> {
    const [row] = await this.db
      .select({
        id: products.id,
        sku: products.sku,
        name: products.name,
        cost: products.costPrice,
        brand: products.brand,
        categoryId: products.categoryId,
        categoryName: products.categoryName,
      })
      .from(products)
      .where(and(eq(products.id, productId), isNull(products.deletedAt)))
      .limit(1);
    if (!row) throw new PricingConfigError('NOT_FOUND', 'That product does not exist.');
    const [rules, fp] = await Promise.all([
      this.guard.rules(companyId),
      this.guard.floorProducts(companyId, [productId]),
    ]);
    const p = fp.get(productId)!;
    const labels = await this.guard.ruleLabels(companyId, rules);
    const result = resolveFloor(p, rules);
    const cost = Number(row.cost ?? 0);

    const applicable = rules.filter(
      (r) =>
        r.scopeType === 'default' ||
        (r.scopeType === 'product' && r.scopeRef === productId) ||
        (r.scopeType === 'product_group' && p.groupIds.includes(r.scopeRef)) ||
        (r.scopeType === 'brand' &&
          p.brand != null &&
          r.scopeRef.toLowerCase() === p.brand.trim().toLowerCase()) ||
        (r.scopeType === 'category' && p.categoryChain.includes(r.scopeRef)),
    );
    const rank = (r: (typeof rules)[number]) =>
      r.scopeType === 'product'
        ? 0
        : r.scopeType === 'product_group' || r.scopeType === 'brand'
          ? 1
          : r.scopeType === 'category'
            ? 2 + p.categoryChain.indexOf(r.scopeRef)
            : 100;
    const considered = applicable
      .sort((a, b) => rank(a) - rank(b) || b.markupPercent - a.markupPercent)
      .map((r) => {
        const used = result.rule?.id === r.id;
        return {
          label: describeRule(r, labels),
          markupPercent: r.markupPercent,
          floorNet:
            cost > 0 ? Math.round(cost * (1 + r.markupPercent / 100) * 10000) / 10000 : null,
          used,
          why: used
            ? 'This is the rule that applies.'
            : r.scopeType === 'default'
              ? 'A more specific rule applies, so the default is not used.'
              : 'Another rule is more specific, or stricter at the same level.',
        };
      });
    const summary = !result.rule
      ? 'No floor rule applies to this product, so it can be sold at any price.'
      : result.floorNet == null
        ? (result.note ?? 'The floor cannot be worked out.')
        : `Floor ${result.floorNet.toFixed(2)} before tax: cost ${cost.toFixed(2)} + ${result.rule.markupPercent}% (${describeRule(result.rule, labels)}). ${result.rule.enforcement === 'block' ? 'A sale below it is refused.' : 'A sale below it needs approval.'}`;
    return {
      product: {
        id: row.id,
        sku: row.sku,
        name: row.name,
        cost,
        brand: row.brand,
        category: row.categoryName,
      },
      floorNet: result.floorNet,
      summary,
      considered,
    };
  }

  // ── Override limits ──────────────────────────────────────────────────────

  async listRoles() {
    return this.db
      .select({ key: roles.key, name: roles.name })
      .from(roles)
      .where(eq(roles.isActive, true))
      .orderBy(asc(roles.priority), asc(roles.name));
  }

  async listLimits(companyId: string) {
    const [limits, rs] = await Promise.all([
      this.db
        .select()
        .from(priceOverrideLimits)
        .where(eq(priceOverrideLimits.companyId, companyId))
        .orderBy(asc(priceOverrideLimits.roleKey)),
      this.listRoles(),
    ]);
    const names = new Map(rs.map((r) => [r.key, r.name]));
    return limits.map((l) => ({
      id: l.id,
      roleKey: l.roleKey,
      roleName: l.roleKey === '*' ? 'Everyone else' : (names.get(l.roleKey) ?? l.roleKey),
      maxPercent: Number(l.maxPercent),
      version: l.version,
      updatedAt: l.updatedAt.toISOString(),
    }));
  }

  async setLimit(
    companyId: string,
    input: { roleKey: string; maxPercent: number },
    actor: Actor,
    reason: Why,
  ) {
    const why = await this.why(companyId, reason);
    const roleKey = input.roleKey.trim();
    if (!roleKey) throw new PricingConfigError('INVALID', 'Choose a role.');
    if (!Number.isFinite(input.maxPercent) || input.maxPercent < 0 || input.maxPercent > 100)
      throw new PricingConfigError('INVALID', 'The limit must be between 0 and 100%.');
    if (roleKey !== '*') {
      const [r] = await this.db
        .select({ key: roles.key })
        .from(roles)
        .where(eq(roles.key, roleKey))
        .limit(1);
      if (!r) throw new PricingConfigError('NOT_FOUND', `There is no role "${roleKey}".`);
    }
    await this.db.transaction(async (tx) => {
      const [before] = await tx
        .select()
        .from(priceOverrideLimits)
        .where(
          and(
            eq(priceOverrideLimits.companyId, companyId),
            eq(priceOverrideLimits.roleKey, roleKey),
          ),
        )
        .for('update')
        .limit(1);
      let id: string;
      if (before) {
        await tx
          .update(priceOverrideLimits)
          .set({
            maxPercent: input.maxPercent.toFixed(3),
            version: before.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(priceOverrideLimits.id, before.id));
        id = before.id;
      } else {
        const [row] = await tx
          .insert(priceOverrideLimits)
          .values({
            companyId,
            roleKey,
            maxPercent: input.maxPercent.toFixed(3),
            createdBy: actor.id ?? 'system',
          })
          .returning();
        id = row!.id;
      }
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_override_limit', id },
          action: before ? 'pricing.limit_changed' : 'pricing.limit_created',
          reason: why,
          inputs: before ? { maxPercent: Number(before.maxPercent) } : {},
          outcome: { roleKey, maxPercent: input.maxPercent },
        },
        tx,
      );
    });
    this.guard.invalidate(companyId);
  }

  async removeLimit(companyId: string, id: string, actor: Actor, reason: Why) {
    const why = await this.why(companyId, reason);
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .delete(priceOverrideLimits)
        .where(and(eq(priceOverrideLimits.companyId, companyId), eq(priceOverrideLimits.id, id)))
        .returning();
      if (!row) throw new PricingConfigError('NOT_FOUND', 'That limit does not exist.');
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'price_override_limit', id },
          action: 'pricing.limit_removed',
          reason: why,
          inputs: { roleKey: row.roleKey, maxPercent: Number(row.maxPercent) },
        },
        tx,
      );
    });
    this.guard.invalidate(companyId);
  }

  // ── Product groups ───────────────────────────────────────────────────────

  async listProductGroups(companyId: string) {
    const rows = await this.db
      .select()
      .from(productGroups)
      .where(eq(productGroups.companyId, companyId))
      .orderBy(asc(productGroups.code));
    if (rows.length === 0) return [];
    const counts = await this.db
      .select({ id: productGroupMembers.groupId, n: count() })
      .from(productGroupMembers)
      .where(
        inArray(
          productGroupMembers.groupId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(productGroupMembers.groupId);
    const byId = new Map(counts.map((c) => [c.id, Number(c.n)]));
    return rows.map((r) => ({ ...r, memberCount: byId.get(r.id) ?? 0 }));
  }

  async saveProductGroup(
    companyId: string,
    input: {
      id?: string;
      code: string;
      name: string;
      description?: string | null;
      isActive?: boolean;
    },
    actor: Actor,
    reason: Why,
  ) {
    const why = await this.why(companyId, reason);
    const code = input.code.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code))
      throw new PricingConfigError(
        'INVALID',
        'The code can use letters, numbers, "-" and "_" (up to 40).',
      );
    if (!input.name?.trim()) throw new PricingConfigError('INVALID', 'Give the group a name.');
    const [dup] = await this.db
      .select({ id: productGroups.id })
      .from(productGroups)
      .where(
        and(
          eq(productGroups.companyId, companyId),
          eq(productGroups.code, code),
          input.id ? ne(productGroups.id, input.id) : undefined,
        ),
      )
      .limit(1);
    if (dup)
      throw new PricingConfigError('DUPLICATE_CODE', `A product group ${code} already exists.`);
    const values = {
      code,
      name: input.name.trim(),
      description: input.description?.trim() || null,
      isActive: input.isActive ?? true,
    };
    const row = await this.db.transaction(async (tx) => {
      let saved;
      if (input.id) {
        const [before] = await tx
          .select()
          .from(productGroups)
          .where(and(eq(productGroups.companyId, companyId), eq(productGroups.id, input.id)))
          .limit(1);
        if (!before) throw new PricingConfigError('NOT_FOUND', 'That group does not exist.');
        [saved] = await tx
          .update(productGroups)
          .set({ ...values, updatedAt: new Date() })
          .where(eq(productGroups.id, input.id))
          .returning();
        await this.decisions.record(
          {
            companyId,
            actor,
            subject: { type: 'product_group', id: input.id },
            action: 'pricing.product_group_changed',
            reason: why,
            inputs: { name: before.name, isActive: before.isActive },
            outcome: values,
          },
          tx,
        );
      } else {
        [saved] = await tx
          .insert(productGroups)
          .values({ companyId, ...values, createdBy: actor.id ?? 'system' })
          .returning();
        await this.decisions.record(
          {
            companyId,
            actor,
            subject: { type: 'product_group', id: saved!.id },
            action: 'pricing.product_group_created',
            reason: why,
            outcome: values,
          },
          tx,
        );
      }
      return saved!;
    });
    this.guard.invalidate(companyId);
    return row;
  }

  async groupMembers(companyId: string, groupId: string, search?: string, limit = 100) {
    await this.assertGroup(companyId, groupId);
    const s = search?.trim();
    return this.db
      .select({ id: products.id, sku: products.sku, name: products.name, cost: products.costPrice })
      .from(productGroupMembers)
      .innerJoin(products, eq(products.id, productGroupMembers.productId))
      .where(
        and(
          eq(productGroupMembers.groupId, groupId),
          s ? or(ilike(products.name, `%${s}%`), ilike(products.sku, `%${s}%`)) : undefined,
        ),
      )
      .orderBy(asc(products.name))
      .limit(limit);
  }

  /** Adds products to a group (by id, or by SKU). Already-in products are left alone. */
  async addMembers(
    companyId: string,
    groupId: string,
    input: { productIds?: string[]; skus?: string[] },
    actor: Actor,
    reason: Why,
  ) {
    const why = await this.why(companyId, reason);
    await this.assertGroup(companyId, groupId);
    const ids = new Set(input.productIds ?? []);
    const skus = [...new Set((input.skus ?? []).map((s) => s.trim()).filter(Boolean))];
    if (ids.size + skus.length === 0)
      throw new PricingConfigError('INVALID', 'Choose at least one product.');
    if (ids.size + skus.length > MAX_GROUP_CHANGE)
      throw new PricingConfigError(
        'TOO_MANY',
        `Add at most ${MAX_GROUP_CHANGE.toLocaleString()} products at a time.`,
      );
    const unknownSkus: string[] = [];
    if (skus.length > 0) {
      const found = await this.db
        .select({ id: products.id, sku: products.sku })
        .from(products)
        .where(and(inArray(products.sku, skus), isNull(products.deletedAt)));
      const bySku = new Set(found.map((f) => f.sku.toLowerCase()));
      for (const f of found) ids.add(f.id);
      for (const s of skus) if (!bySku.has(s.toLowerCase())) unknownSkus.push(s);
    }
    if (unknownSkus.length > 0)
      throw new PricingConfigError(
        'INVALID',
        `${unknownSkus.length} SKU${unknownSkus.length === 1 ? '' : 's'} not found (for example ${unknownSkus[0]}). Nothing was added.`,
      );
    const valid = await this.db
      .select({ id: products.id })
      .from(products)
      .where(and(inArray(products.id, [...ids]), isNull(products.deletedAt)));
    if (valid.length !== ids.size)
      throw new PricingConfigError(
        'INVALID',
        'Some of those products no longer exist. Nothing was added.',
      );
    const added = await this.db.transaction(async (tx) => {
      let n = 0;
      for (let i = 0; i < valid.length; i += 1000) {
        const rows = await tx
          .insert(productGroupMembers)
          .values(
            valid
              .slice(i, i + 1000)
              .map((p) => ({ groupId, productId: p.id, addedBy: actor.id ?? null })),
          )
          .onConflictDoNothing()
          .returning({ id: productGroupMembers.productId });
        n += rows.length;
      }
      if (n > 0)
        await this.decisions.record(
          {
            companyId,
            actor,
            subject: { type: 'product_group', id: groupId },
            action: 'pricing.product_group_members_added',
            reason: why,
            outcome: { added: n, requested: valid.length },
          },
          tx,
        );
      return n;
    });
    this.guard.invalidate(companyId);
    return { added, alreadyIn: valid.length - added };
  }

  async removeMembers(
    companyId: string,
    groupId: string,
    productIds: string[],
    actor: Actor,
    reason: Why,
  ) {
    const why = await this.why(companyId, reason);
    await this.assertGroup(companyId, groupId);
    if (productIds.length === 0 || productIds.length > MAX_GROUP_CHANGE)
      throw new PricingConfigError('INVALID', 'Choose the products to remove.');
    const removed = await this.db.transaction(async (tx) => {
      const rows = await tx
        .delete(productGroupMembers)
        .where(
          and(
            eq(productGroupMembers.groupId, groupId),
            inArray(productGroupMembers.productId, productIds),
          ),
        )
        .returning({ id: productGroupMembers.productId });
      if (rows.length > 0)
        await this.decisions.record(
          {
            companyId,
            actor,
            subject: { type: 'product_group', id: groupId },
            action: 'pricing.product_group_members_removed',
            reason: why,
            outcome: { removed: rows.length },
          },
          tx,
        );
      return rows.length;
    });
    this.guard.invalidate(companyId);
    return { removed };
  }

  // ── Lookups ──────────────────────────────────────────────────────────────

  async brands(): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ brand: products.brand })
      .from(products)
      .where(
        and(
          isNull(products.deletedAt),
          sql`${products.brand} is not null and ${products.brand} <> ''`,
        ),
      )
      .orderBy(asc(products.brand))
      .limit(500);
    return rows.map((r) => r.brand!);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  private async assertGroup(companyId: string, groupId: string) {
    const [g] = await this.db
      .select({ id: productGroups.id })
      .from(productGroups)
      .where(and(eq(productGroups.companyId, companyId), eq(productGroups.id, groupId)))
      .limit(1);
    if (!g) throw new PricingConfigError('NOT_FOUND', 'That product group does not exist.');
  }

  private async assertScopeExists(companyId: string, type: FloorScopeType, ref: string) {
    if (type === 'default') return;
    if (type === 'brand') {
      const [b] = await this.db
        .select({ id: products.id })
        .from(products)
        .where(and(sql`lower(${products.brand}) = lower(${ref})`, isNull(products.deletedAt)))
        .limit(1);
      if (!b) throw new PricingConfigError('NOT_FOUND', `No product has the brand "${ref}".`);
      return;
    }
    const table =
      type === 'product'
        ? this.db
            .select({ id: products.id })
            .from(products)
            .where(and(eq(products.id, ref), isNull(products.deletedAt)))
        : type === 'category'
          ? this.db.select({ id: categories.id }).from(categories).where(eq(categories.id, ref))
          : this.db
              .select({ id: productGroups.id })
              .from(productGroups)
              .where(and(eq(productGroups.id, ref), eq(productGroups.companyId, companyId)));
    const [hit] = await table.limit(1);
    if (!hit)
      throw new PricingConfigError(
        'NOT_FOUND',
        type === 'product'
          ? 'That product does not exist.'
          : type === 'category'
            ? 'That category does not exist.'
            : 'That product group does not exist.',
      );
  }

  /** Words for what each rule points at: category paths, group names, product names. */
  private async labelsFor(
    companyId: string,
    rules: Array<{ scopeType: FloorScopeType; scopeRef: string }>,
  ): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const of = (t: FloorScopeType) => rules.filter((r) => r.scopeType === t).map((r) => r.scopeRef);
    const [cats, groups, prods] = await Promise.all([
      of('category').length
        ? this.db
            .select({ id: categories.id, name: categories.name, parentId: categories.parentId })
            .from(categories)
        : [],
      of('product_group').length
        ? this.db
            .select({ id: productGroups.id, name: productGroups.name })
            .from(productGroups)
            .where(
              and(
                eq(productGroups.companyId, companyId),
                inArray(productGroups.id, of('product_group')),
              ),
            )
        : [],
      of('product').length
        ? this.db
            .select({ id: products.id, name: products.name, sku: products.sku })
            .from(products)
            .where(inArray(products.id, of('product')))
        : [],
    ]);
    const parents = new Map(cats.map((c) => [c.id, c.parentId]));
    const names = new Map(cats.map((c) => [c.id, c.name]));
    for (const r of rules) {
      if (r.scopeType === 'default') out['default:'] = 'Everything (company default)';
      else if (r.scopeType === 'brand') out[`brand:${r.scopeRef}`] = r.scopeRef;
      else if (r.scopeType === 'category')
        out[`category:${r.scopeRef}`] = categoryChain(r.scopeRef, parents)
          .reverse()
          .map((id) => names.get(id) ?? id)
          .join(' › ');
    }
    for (const g of groups) out[`product_group:${g.id}`] = g.name;
    for (const p of prods) out[`product:${p.id}`] = `${p.name} (${p.sku})`;
    return out;
  }
}
