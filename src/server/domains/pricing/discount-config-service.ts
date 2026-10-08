import { randomInt } from 'node:crypto';
import { and, asc, count, desc, eq, inArray, ne, sql } from 'drizzle-orm';
import type { DrizzleDb } from '@/server/db/drizzle/client';
import {
  branches,
  categories,
  customerGroups,
  customers,
  decisionLog,
  discountCounters,
  discountCoupons,
  discountRules,
  discountUsage,
  productGroups,
  products,
} from '@/server/db/drizzle/schema';
import { afterCommit, withAfterCommit } from '@/server/kernel/after-commit';
import type { ApprovalEngine, Tx } from '@/server/kernel/approvals/engine';
import type { Actor } from '@/server/kernel/context';
import type { DecisionLog } from '@/server/kernel/decision-log/service';
import type { ReasonCodes, ReasonInput } from '@/server/kernel/reason-codes/service';
import { PricingConfigError, type PricingConfigService } from './config-service';
import {
  checkDiscountRule,
  summariseDiscount,
  type DiscountRuleInput,
  type RuleChecks,
} from './domain/discount-rules';
import type { RuleIssue } from './domain/rules';
import {
  NO_REWARD,
  type DiscountKind,
  type DiscountStatus,
  type DiscountTarget,
} from './domain/discounts';
import type { BasketDiscounts, DiscountService, PricedItem } from './discount-service';
import { toRule, type DiscountRuleRow } from './discount-service';
import type { PricingService } from './service';
import type { InsightsService } from './insights-service';

type Why = ReasonInput;
const MAX_COUPONS_PER_CALL = 1000;
/** No 0/O or 1/I/L, so a code read out loud or copied by eye is not mistyped. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Every product selector a rule uses: its own target, and each part of its deal. */
export function targetsOf(r: {
  target: DiscountTarget;
  mix?: DiscountRuleRow['mix'];
}): DiscountTarget[] {
  const out: DiscountTarget[] = [r.target];
  const m = r.mix;
  if (!m) return out;
  if (m.type === 'buy_get') out.push(m.buy.target, m.get.target);
  else if (m.type === 'mix_match') out.push(m.set);
  else if (m.type === 'bundle_deal') out.push(...m.slots.map((x) => x.target));
  else if (m.trigger.target) out.push(m.trigger.target);
  return out;
}

/** Products a gift rule gives away. */
export const giftProductIds = (r: { mix?: DiscountRuleRow['mix'] }): string[] =>
  r.mix?.type === 'gift' ? r.mix.gifts.map((g) => g.productId) : [];

export interface DiscountRuleView extends DiscountRuleRow {
  summary: string;
  uses: number;
  given: number;
  couponCount: number;
}

export interface CouponView {
  id: string;
  code: string;
  validFrom: string;
  validTo: string | null;
  maxUses: number | null;
  maxUsesPerCustomer: number | null;
  status: 'active' | 'disabled';
  uses: number;
}

export interface SimulationInput {
  customerId?: string | null;
  channel?: string;
  salesType?: string;
  paymentMethod?: string | null;
  couponCodes?: string[];
  at?: Date;
  /** A draft or paused rule to try as if it were in force. */
  tryRuleId?: string;
  lines: Array<{ productId: string; quantity: number }>;
}

export interface SimulationResult {
  lines: Array<{
    productId: string;
    name: string;
    quantity: number;
    unitPriceBefore: number | null;
    unitPriceAfter: number | null;
    lineTotalBefore: number | null;
    lineTotalAfter: number | null;
    problem: string | null;
    applied: Array<{
      code: string;
      name: string;
      level: 'line' | 'order';
      amount: number;
      how: string;
    }>;
    considered: Array<{ code: string; outcome: string; why: string }>;
  }>;
  totalBefore: number;
  totalAfter: number;
  totalDiscount: number;
  couponProblems: Array<{ code: string; reason: string }>;
  orderConsidered: Array<{ code: string; outcome: string; why: string }>;
  /** Free items the basket has earned. */
  gifts: Array<{
    code: string;
    ruleName: string;
    productName: string;
    quantity: number;
    value: number;
  }>;
}

/**
 * Everything an administrator does with discount rules and coupons. A rule is edited only while it
 * is a draft or paused (never while it is pricing sales), every change needs a reason, and putting
 * a rule in force can go through the approval workflow. Changes are written to the decision log.
 */
export class DiscountConfigService {
  constructor(
    private readonly db: DrizzleDb,
    private readonly decisions: DecisionLog,
    private readonly reasons: ReasonCodes,
    private readonly discounts: DiscountService,
    private readonly pricing: PricingService,
    private readonly pricingConfig: PricingConfigService,
    private readonly approvals: ApprovalEngine,
    private readonly insights?: InsightsService,
  ) {}

  private why(companyId: string, reason: Why) {
    return this.reasons.require(companyId, reason, 'pricing_configuration');
  }

  private normaliseCode(raw: string) {
    const code = raw.trim().toUpperCase();
    if (!/^[A-Z0-9][A-Z0-9_-]{0,39}$/.test(code))
      throw new PricingConfigError(
        'INVALID',
        'The code can use letters, numbers, "-" and "_" (up to 40).',
      );
    return code;
  }

  // ── Reading ──────────────────────────────────────────────────────────────

  async listRules(companyId: string): Promise<DiscountRuleView[]> {
    const rows = await this.db
      .select()
      .from(discountRules)
      .where(eq(discountRules.companyId, companyId))
      .orderBy(asc(discountRules.status), desc(discountRules.priority), asc(discountRules.code));
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);
    const [counters, coupons] = await Promise.all([
      this.db
        .select({
          id: discountCounters.ruleId,
          uses: sql<number>`sum(${discountCounters.uses})::int`,
          amount: sql<string>`sum(${discountCounters.amount})`,
        })
        .from(discountCounters)
        .where(inArray(discountCounters.ruleId, ids))
        .groupBy(discountCounters.ruleId),
      this.db
        .select({ id: discountCoupons.ruleId, n: count() })
        .from(discountCoupons)
        .where(inArray(discountCoupons.ruleId, ids))
        .groupBy(discountCoupons.ruleId),
    ]);
    const c = new Map(counters.map((x) => [x.id, x]));
    const k = new Map(coupons.map((x) => [x.id, Number(x.n)]));
    const names = await this.namesFor(companyId, rows);
    return rows.map((r) => ({
      ...r,
      summary: summariseDiscount(this.toInput(r), names),
      uses: c.get(r.id)?.uses ?? 0,
      given: Number(c.get(r.id)?.amount ?? 0),
      couponCount: k.get(r.id) ?? 0,
    }));
  }

  async getRule(companyId: string, id: string): Promise<DiscountRuleRow> {
    const [row] = await this.db
      .select()
      .from(discountRules)
      .where(and(eq(discountRules.companyId, companyId), eq(discountRules.id, id)))
      .limit(1);
    if (!row) throw new PricingConfigError('NOT_FOUND', 'That discount rule does not exist.');
    return row;
  }

  async getRuleView(companyId: string, id: string): Promise<DiscountRuleView> {
    const row = await this.getRule(companyId, id);
    const [counter] = await this.db
      .select({
        uses: sql<number>`coalesce(sum(${discountCounters.uses}), 0)::int`,
        amount: sql<string>`coalesce(sum(${discountCounters.amount}), 0)`,
      })
      .from(discountCounters)
      .where(eq(discountCounters.ruleId, id));
    const [coupons] = await this.db
      .select({ n: count() })
      .from(discountCoupons)
      .where(eq(discountCoupons.ruleId, id));
    const names = await this.namesFor(companyId, [row]);
    return {
      ...row,
      summary: summariseDiscount(this.toInput(row), names),
      uses: counter?.uses ?? 0,
      given: Number(counter?.amount ?? 0),
      couponCount: Number(coupons?.n ?? 0),
    };
  }

  async timeline(id: string) {
    return this.decisions.timeline('discount_rule', id);
  }

  /** The most recent uses of a rule, for the detail screen. */
  async recentUsage(companyId: string, ruleId: string, limit = 20) {
    return this.db
      .select({
        documentType: discountUsage.documentType,
        documentId: discountUsage.documentId,
        kind: discountUsage.kind,
        amount: discountUsage.amount,
        couponCode: discountUsage.couponCode,
        occurredAt: discountUsage.occurredAt,
      })
      .from(discountUsage)
      .where(and(eq(discountUsage.companyId, companyId), eq(discountUsage.ruleId, ruleId)))
      .orderBy(desc(discountUsage.occurredAt))
      .limit(limit);
  }

  private toInput(r: DiscountRuleRow): DiscountRuleInput {
    return {
      code: r.code,
      name: r.name,
      kind: r.kind,
      priority: r.priority,
      stacking: r.stacking,
      validFrom: r.validFrom,
      validTo: r.validTo,
      schedule: r.schedule,
      scopes: r.scopes,
      target: r.target,
      conditions: r.conditions,
      reward: r.reward ?? NO_REWARD,
      mix: r.mix ?? null,
      requiresCoupon: r.requiresCoupon,
      limits: r.limits,
    };
  }

  /** Words for the categories, groups, products, customers and branches the rules point at. */
  async namesFor(companyId: string, rows: DiscountRuleRow[]) {
    const ids = (pick: (r: DiscountRuleRow) => string[] | undefined) => [
      ...new Set(rows.flatMap((r) => pick(r) ?? [])),
    ];
    const cat = ids((r) => targetsOf(r).flatMap((t) => t.categoryIds ?? []));
    const grp = ids((r) => targetsOf(r).flatMap((t) => t.productGroupIds ?? []));
    const prd = ids((r) => [
      ...targetsOf(r).flatMap((t) => t.productIds ?? []),
      ...giftProductIds(r),
    ]);
    const cus = ids((r) => r.scopes.customer?.values);
    const cgr = ids((r) => r.scopes.customer_group?.values);
    const brn = ids((r) => r.scopes.branch?.values);
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const onlyUuid = (xs: string[]) => xs.filter((x) => uuid.test(x));
    const [c, g, p, cu, cg, b] = await Promise.all([
      cat.length
        ? this.db
            .select({ id: categories.id, name: categories.name })
            .from(categories)
            .where(inArray(categories.id, cat))
        : [],
      onlyUuid(grp).length
        ? this.db
            .select({ id: productGroups.id, name: productGroups.name })
            .from(productGroups)
            .where(inArray(productGroups.id, onlyUuid(grp)))
        : [],
      prd.length
        ? this.db
            .select({ id: products.id, name: products.name })
            .from(products)
            .where(inArray(products.id, prd))
        : [],
      onlyUuid(cus).length
        ? this.db
            .select({ id: customers.id, name: customers.name })
            .from(customers)
            .where(inArray(customers.id, onlyUuid(cus)))
        : [],
      onlyUuid(cgr).length
        ? this.db
            .select({ id: customerGroups.id, name: customerGroups.name })
            .from(customerGroups)
            .where(inArray(customerGroups.id, onlyUuid(cgr)))
        : [],
      onlyUuid(brn).length
        ? this.db
            .select({ id: branches.id, name: branches.name })
            .from(branches)
            .where(inArray(branches.id, onlyUuid(brn)))
        : [],
    ]);
    const m = (xs: Array<{ id: string; name: string }>) =>
      Object.fromEntries(xs.map((x) => [x.id, x.name]));
    return {
      category: m(c),
      group: m(g),
      product: m(p),
      customer: m(cu),
      customer_group: m(cg),
      branch: m(b),
    };
  }

  // ── Checks ───────────────────────────────────────────────────────────────

  /** Everything wrong with a rule's settings, and everything worth a second look. */
  async check(companyId: string, input: DiscountRuleInput): Promise<RuleChecks> {
    const checks = checkDiscountRule(input);
    checks.errors.push(...(await this.checkReferences(companyId, input)));
    return checks;
  }

  /** The things a rule names must exist (and belong to this company). */
  private async checkReferences(companyId: string, r: DiscountRuleInput): Promise<RuleIssue[]> {
    const issues: RuleIssue[] = [];
    const all = targetsOf(r);
    const t = {
      categoryIds: [...new Set(all.flatMap((x) => x.categoryIds ?? []))],
      productGroupIds: [...new Set(all.flatMap((x) => x.productGroupIds ?? []))],
      productIds: [...new Set(all.flatMap((x) => x.productIds ?? []))],
    };
    const missing = async (
      label: string,
      path: string,
      wanted: string[] | undefined,
      lookup: (ids: string[]) => Promise<string[]>,
    ) => {
      if (!wanted?.length) return;
      const found = new Set(await lookup(wanted));
      const gone = wanted.filter((w) => !found.has(w));
      if (gone.length)
        issues.push({
          path,
          message: `${gone.length} ${label}${gone.length === 1 ? '' : 's'} no longer exist (for example ${gone[0]}).`,
        });
    };
    await missing('category', 'target.categoryIds', t.categoryIds, async (ids) =>
      (
        await this.db
          .select({ id: categories.id })
          .from(categories)
          .where(inArray(categories.id, ids))
      ).map((x) => x.id),
    );
    await missing('product group', 'target.productGroupIds', t.productGroupIds, async (ids) =>
      (
        await this.db
          .select({ id: productGroups.id })
          .from(productGroups)
          .where(and(inArray(productGroups.id, ids), eq(productGroups.companyId, companyId)))
      ).map((x) => x.id),
    );
    await missing('product', 'target.productIds', t.productIds, async (ids) =>
      (
        await this.db.select({ id: products.id }).from(products).where(inArray(products.id, ids))
      ).map((x) => x.id),
    );
    // A gift must be a real product that is still on sale.
    const gifts = giftProductIds(r);
    if (gifts.length > 0) {
      const live = await this.db
        .select({ id: products.id, active: products.isActive, deleted: products.deletedAt })
        .from(products)
        .where(inArray(products.id, gifts));
      const ok = new Set(live.filter((p) => p.active && p.deleted == null).map((p) => p.id));
      const bad = gifts.filter((g) => !ok.has(g));
      if (bad.length)
        issues.push({
          path: 'mix.gifts',
          message: `${bad.length} gift product${bad.length === 1 ? ' is' : 's are'} missing or switched off.`,
        });
    }
    issues.push(...(await this.pricingConfig.checkScopeReferences(companyId, r.scopes)));
    return issues;
  }

  /** Why a rule cannot go in force yet, or an empty list. */
  async activationIssues(companyId: string, id: string): Promise<RuleIssue[]> {
    const row = await this.getRule(companyId, id);
    if (row.status === 'retired')
      return [{ path: 'status', message: 'A retired rule cannot be put in force again.' }];
    const checks = await this.check(companyId, this.toInput(row));
    const issues = [...checks.errors];
    if (row.validTo && row.validTo <= new Date())
      issues.push({ path: 'validTo', message: 'The rule has already ended.' });
    if (row.requiresCoupon) {
      const [n] = await this.db
        .select({ n: count() })
        .from(discountCoupons)
        .where(and(eq(discountCoupons.ruleId, id), eq(discountCoupons.status, 'active')));
      if (Number(n?.n ?? 0) === 0)
        issues.push({
          path: 'coupons',
          message: 'It needs a coupon code, and has none. Add one first.',
        });
    }
    return issues;
  }

  // ── Changing rules ───────────────────────────────────────────────────────

  async createRule(
    companyId: string,
    input: DiscountRuleInput & {
      description?: string | null;
      strictLimits?: boolean;
      appliesToContract?: boolean;
    },
    actor: Actor,
    reason: Why,
  ): Promise<DiscountRuleRow> {
    const why = await this.why(companyId, reason);
    const code = this.normaliseCode(input.code);
    const checks = await this.check(companyId, { ...input, code });
    if (checks.errors.length)
      throw new PricingConfigError('INVALID', checks.errors[0]!.message, checks.errors);
    const [dup] = await this.db
      .select({ id: discountRules.id })
      .from(discountRules)
      .where(and(eq(discountRules.companyId, companyId), eq(discountRules.code, code)))
      .limit(1);
    if (dup)
      throw new PricingConfigError('DUPLICATE_CODE', `A discount rule ${code} already exists.`);
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(discountRules)
        .values({
          companyId,
          code,
          name: input.name.trim(),
          kind: input.kind,
          priority: input.priority,
          stacking: input.stacking,
          validFrom: input.validFrom,
          validTo: input.validTo,
          schedule: input.schedule,
          scopes: input.scopes,
          target: input.target,
          conditions: input.conditions,
          // A mix or gift rule is described by its deal; a price rule by its reward.
          reward: input.kind === 'line' || input.kind === 'order' ? input.reward : null,
          mix: input.kind === 'line' || input.kind === 'order' ? null : (input.mix ?? null),
          requiresCoupon: input.requiresCoupon,
          limits: input.limits,
          description: input.description?.trim() || null,
          strictLimits: input.strictLimits ?? false,
          appliesToContract: input.appliesToContract ?? false,
          createdBy: actor.id ?? 'system',
        })
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'discount_rule', id: row!.id },
          action: 'pricing.discount_created',
          reason: why,
          to: 'draft',
          outcome: { code, kind: input.kind, reward: input.reward, mix: input.mix ?? null },
        },
        tx,
      );
      return row!;
    });
  }

  /** Changes a draft or paused rule. Each change adds a version. */
  async updateRule(
    companyId: string,
    id: string,
    patch: Partial<Omit<DiscountRuleInput, 'code' | 'kind'>> & {
      strictLimits?: boolean;
      appliesToContract?: boolean;
      description?: string | null;
    },
    actor: Actor,
    reason: Why,
  ): Promise<DiscountRuleRow> {
    const why = await this.why(companyId, reason);
    const current = await this.getRule(companyId, id);
    if (current.status === 'retired')
      throw new PricingConfigError('NOT_EDITABLE', 'A retired rule cannot be changed.');
    if (current.approvalStatus === 'pending')
      throw new PricingConfigError(
        'NOT_EDITABLE',
        'This rule is waiting for approval. Withdraw the request before changing it.',
      );
    if (current.status === 'active')
      throw new PricingConfigError(
        'NOT_EDITABLE',
        'A rule that is pricing sales cannot be changed. Pause it, change it, then put it back in force.',
      );
    const next = { ...this.toInput(current), ...patch, code: current.code, kind: current.kind };
    const checks = await this.check(companyId, next);
    if (checks.errors.length)
      throw new PricingConfigError('INVALID', checks.errors[0]!.message, checks.errors);
    const set = {
      name: next.name.trim(),
      priority: next.priority,
      stacking: next.stacking,
      validFrom: next.validFrom,
      validTo: next.validTo,
      schedule: next.schedule,
      scopes: next.scopes,
      target: next.target,
      conditions: next.conditions,
      reward: next.kind === 'line' || next.kind === 'order' ? next.reward : null,
      mix: next.kind === 'line' || next.kind === 'order' ? null : (next.mix ?? null),
      requiresCoupon: next.requiresCoupon,
      limits: next.limits,
      strictLimits: patch.strictLimits ?? current.strictLimits,
      appliesToContract: patch.appliesToContract ?? current.appliesToContract,
      description:
        patch.description === undefined ? current.description : patch.description?.trim() || null,
    };
    const changed = Object.entries(set).filter(
      ([k, v]) => JSON.stringify(v) !== JSON.stringify((current as Record<string, unknown>)[k]),
    );
    if (changed.length === 0) return current;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(discountRules)
        .set({ ...set, version: current.version + 1, updatedAt: new Date() })
        .where(eq(discountRules.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'discount_rule', id },
          action: 'pricing.discount_changed',
          reason: why,
          from: `v${current.version}`,
          to: `v${current.version + 1}`,
          inputs: Object.fromEntries(
            changed.map(([k]) => [k, (current as Record<string, unknown>)[k]]),
          ),
          outcome: Object.fromEntries(changed),
        },
        tx,
      );
      return row!;
    });
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Asks for a draft or paused rule to go in force. If an approval workflow applies, it is held
   * until approved; otherwise it goes in force now.
   */
  async requestActivation(
    companyId: string,
    id: string,
    actor: { type: 'user'; id: string },
    reason: Why,
  ): Promise<{ outcome: 'active' } | { outcome: 'pending'; message: string }> {
    const why = await this.why(companyId, reason);
    const rule = await this.getRule(companyId, id);
    if (rule.approvalStatus === 'pending')
      throw new PricingConfigError('NOT_EDITABLE', 'This rule is already waiting for approval.');
    if (rule.status === 'active' || rule.status === 'retired')
      throw new PricingConfigError(
        'NOT_EDITABLE',
        'Only a draft or paused rule can be put in force.',
      );
    const issues = await this.activationIssues(companyId, id);
    if (issues.length) throw new PricingConfigError('INVALID', issues[0]!.message, issues);

    // What the rule would have cost over recent sales goes to the approver; a failure to work it
    // out never blocks the request.
    const impact = await this.insights?.impactOfRule(companyId, id).catch(() => null);
    const request = this.approvalRequest(companyId, rule, actor.id, impact ?? null);
    if (!(await this.approvals.wouldRequire(request))) {
      await this.activate(companyId, id, actor, why);
      return { outcome: 'active' };
    }
    const held = await withAfterCommit(this.db, async (tx) => {
      const claimed = await tx
        .update(discountRules)
        .set({ approvalStatus: 'pending', updatedAt: new Date() })
        .where(and(eq(discountRules.id, id), ne(discountRules.approvalStatus, 'pending')))
        .returning({ id: discountRules.id });
      if (claimed.length === 0)
        throw new PricingConfigError('CONFLICT', 'This rule is already waiting for approval.');
      await this.approvals.supersedePending(
        companyId,
        'discount_rule',
        id,
        { userId: actor.id },
        'Asked again.',
        tx,
        true,
      );
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'discount_rule', id },
          action: 'pricing.discount_activation_requested',
          reason: why,
          from: rule.status,
          to: 'pending_approval',
          inputs: request.snapshot,
        },
        tx,
      );
      const outcome = await this.approvals.submit(request, tx);
      if (!outcome.required) {
        await tx
          .update(discountRules)
          .set({ approvalStatus: 'none' })
          .where(eq(discountRules.id, id));
        return false;
      }
      return true;
    });
    if (!held) {
      await this.activate(companyId, id, actor, why);
      return { outcome: 'active' };
    }
    this.discounts.invalidate(companyId);
    const after = await this.getRule(companyId, id);
    if (after.status === 'active') return { outcome: 'active' };
    return {
      outcome: 'pending',
      message:
        'Sent for approval. The rule goes in force as soon as it is approved; follow it under My requests.',
    };
  }

  private approvalRequest(
    companyId: string,
    rule: DiscountRuleRow,
    requestedBy: string,
    impact: Awaited<ReturnType<InsightsService['impactOfRule']>> | null = null,
  ) {
    const reward = rule.reward;
    const pct =
      reward?.type === 'percent'
        ? Math.max(reward.value, ...(reward.tiers ?? []).map((t) => t.value))
        : 0;
    return {
      companyId,
      trigger: 'discount_rule.publish',
      documentId: rule.id,
      branchId: null,
      requestedBy,
      amount: rule.limits.budget ?? 0,
      snapshot: {
        ruleKind: rule.kind,
        rewardPercent: pct,
        budget: rule.limits.budget ?? 0,
        hasEndDate: rule.validTo != null,
        requiresCoupon: rule.requiresCoupon,
        projectedGiveaway: impact?.supported ? impact.giveaway : 0,
        projectedYearly: impact?.supported ? impact.yearly : 0,
        marginAfterPercent: impact?.supported ? (impact.marginAfterPercent ?? 0) : 0,
        version: rule.version,
      },
    };
  }

  /** The facts an approver's conditions look at, as they are now (to notice edits made after asking). */
  async approvalSnapshot(db: Pick<DrizzleDb, 'select'>, id: string) {
    const [r] = await db.select().from(discountRules).where(eq(discountRules.id, id)).limit(1);
    return { version: r?.version ?? 0 };
  }

  /** Puts the rule in force. Called directly, or by the approval workflow in the approver's transaction. */
  async activate(
    companyId: string,
    id: string,
    actor: Actor,
    reason: Why,
    writer?: Pick<DrizzleDb, 'update' | 'insert'>,
  ) {
    const why = await this.why(companyId, reason);
    const issues = await this.activationIssues(companyId, id);
    if (issues.length) throw new PricingConfigError('INVALID', issues[0]!.message, issues);
    const before = await this.getRule(companyId, id);
    const run = async (tx: Pick<DrizzleDb, 'update' | 'insert'>) => {
      const [row] = await tx
        .update(discountRules)
        .set({ status: 'active', approvalStatus: 'none', updatedAt: new Date() })
        .where(eq(discountRules.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'discount_rule', id },
          action: 'pricing.discount_activated',
          reason: why,
          from: before.status,
          to: 'active',
          outcome: { version: row!.version },
        },
        tx,
      );
      return row!;
    };
    if (writer) {
      const row = await run(writer);
      afterCommit(writer, () => this.discounts.invalidate(companyId));
      return row;
    }
    const row = await this.db.transaction(run);
    this.discounts.invalidate(companyId);
    return row;
  }

  async pause(companyId: string, id: string, actor: Actor, reason: Why) {
    return this.move(companyId, id, 'paused', 'pricing.discount_paused', actor, reason, ['active']);
  }

  async retire(companyId: string, id: string, actor: Actor, reason: Why) {
    return this.move(companyId, id, 'retired', 'pricing.discount_retired', actor, reason, [
      'draft',
      'active',
      'paused',
    ]);
  }

  private async move(
    companyId: string,
    id: string,
    to: DiscountStatus,
    action: string,
    actor: Actor,
    reason: Why,
    from: DiscountStatus[],
  ) {
    const why = await this.why(companyId, reason);
    const rule = await this.getRule(companyId, id);
    if (rule.status === to) return rule;
    if (!from.includes(rule.status))
      throw new PricingConfigError(
        'NOT_EDITABLE',
        `A ${rule.status} rule cannot be ${to === 'paused' ? 'paused' : 'retired'}.`,
      );
    const row = await this.db.transaction(async (tx) => {
      const [updated] = await tx
        .update(discountRules)
        .set({ status: to, approvalStatus: 'none', updatedAt: new Date() })
        .where(eq(discountRules.id, id))
        .returning();
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'discount_rule', id },
          action,
          reason: why,
          from: rule.status,
          to,
        },
        tx,
      );
      return updated!;
    });
    this.discounts.invalidate(companyId);
    return row;
  }

  /** What an approval does to the rule's approval state: refused, reopened or withdrawn. */
  async setApprovalState(tx: Pick<DrizzleDb, 'update'>, id: string, state: 'none' | 'rejected') {
    await tx
      .update(discountRules)
      .set({ approvalStatus: state, updatedAt: new Date() })
      .where(eq(discountRules.id, id));
  }

  /** The reason the requester gave, kept when they asked, to be recorded when the approval releases. */
  async requestedWith(tx: Pick<DrizzleDb, 'select'>, id: string) {
    const [row] = await tx
      .select({
        code: decisionLog.reasonCode,
        text: decisionLog.reasonText,
        actorId: decisionLog.actorId,
      })
      .from(decisionLog)
      .where(
        and(
          eq(decisionLog.subjectType, 'discount_rule'),
          eq(decisionLog.subjectId, id),
          eq(decisionLog.action, 'pricing.discount_activation_requested'),
        ),
      )
      .orderBy(desc(decisionLog.occurredAt))
      .limit(1);
    return row ?? null;
  }

  // ── Coupons ──────────────────────────────────────────────────────────────

  async listCoupons(companyId: string, ruleId: string, limit = 200): Promise<CouponView[]> {
    await this.getRule(companyId, ruleId);
    const rows = await this.db
      .select()
      .from(discountCoupons)
      .where(and(eq(discountCoupons.companyId, companyId), eq(discountCoupons.ruleId, ruleId)))
      .orderBy(desc(discountCoupons.createdAt), asc(discountCoupons.code))
      .limit(limit);
    if (rows.length === 0) return [];
    const used = await this.db
      .select({
        id: discountUsage.couponId,
        n: sql<number>`sum(case when ${discountUsage.kind} = 'use' then 1 else -1 end)::int`,
      })
      .from(discountUsage)
      .where(
        inArray(
          discountUsage.couponId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(discountUsage.couponId);
    const u = new Map(used.map((x) => [x.id, x.n]));
    return rows.map((r) => ({
      id: r.id,
      code: r.code,
      validFrom: r.validFrom.toISOString(),
      validTo: r.validTo ? r.validTo.toISOString() : null,
      maxUses: r.maxUses,
      maxUsesPerCustomer: r.maxUsesPerCustomer,
      status: r.status,
      uses: u.get(r.id) ?? 0,
    }));
  }

  /**
   * Adds coupon codes to a rule: codes you type, or a number of random ones. A code that already
   * exists is refused (typed) or skipped (generated).
   */
  async createCoupons(
    companyId: string,
    ruleId: string,
    input: {
      codes?: string[];
      generate?: { count: number; prefix?: string; length?: number };
      validFrom?: Date | null;
      validTo?: Date | null;
      maxUses?: number | null;
      maxUsesPerCustomer?: number | null;
    },
    actor: Actor,
    reason: Why,
  ): Promise<{ created: string[] }> {
    const why = await this.why(companyId, reason);
    const rule = await this.getRule(companyId, ruleId);
    if (rule.status === 'retired')
      throw new PricingConfigError('NOT_EDITABLE', 'A retired rule cannot get new coupons.');
    for (const [k, v] of [
      ['maxUses', input.maxUses],
      ['maxUsesPerCustomer', input.maxUsesPerCustomer],
    ] as const)
      if (v != null && !(Number.isInteger(v) && v > 0))
        throw new PricingConfigError(
          'INVALID',
          `${k === 'maxUses' ? 'The use limit' : 'The limit per customer'} must be a whole number above zero.`,
        );
    if (input.validFrom && input.validTo && input.validTo <= input.validFrom)
      throw new PricingConfigError('INVALID', 'The coupon must end after it starts.');

    let codes: string[];
    if (input.codes?.length) {
      codes = [...new Set(input.codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
      for (const c of codes)
        if (!/^[A-Z0-9][A-Z0-9_-]{2,31}$/.test(c))
          throw new PricingConfigError(
            'INVALID',
            `"${c}" is not a valid code. Use 3 to 32 letters, numbers, "-" or "_".`,
          );
      if (codes.length > MAX_COUPONS_PER_CALL)
        throw new PricingConfigError(
          'TOO_MANY',
          `Add at most ${MAX_COUPONS_PER_CALL.toLocaleString()} codes at a time.`,
        );
      const taken = await this.db
        .select({ code: discountCoupons.code })
        .from(discountCoupons)
        .where(and(eq(discountCoupons.companyId, companyId), inArray(discountCoupons.code, codes)));
      if (taken.length)
        throw new PricingConfigError(
          'DUPLICATE_CODE',
          `The code ${taken[0]!.code} is already in use. Nothing was added.`,
        );
    } else if (input.generate) {
      const n = input.generate.count;
      if (!Number.isInteger(n) || n < 1 || n > MAX_COUPONS_PER_CALL)
        throw new PricingConfigError(
          'INVALID',
          `Make between 1 and ${MAX_COUPONS_PER_CALL.toLocaleString()} codes.`,
        );
      const len = input.generate.length ?? 8;
      if (len < 6 || len > 16)
        throw new PricingConfigError('INVALID', 'Random codes are 6 to 16 characters long.');
      const prefix = (input.generate.prefix ?? '').trim().toUpperCase();
      if (prefix && !/^[A-Z0-9][A-Z0-9_-]{0,15}$/.test(prefix))
        throw new PricingConfigError(
          'INVALID',
          'The prefix can use letters, numbers, "-" and "_" (up to 16).',
        );
      const made = new Set<string>();
      while (made.size < n) {
        let body = '';
        for (let i = 0; i < len; i++) body += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
        made.add(prefix ? `${prefix}-${body}` : body);
      }
      codes = [...made];
    } else {
      throw new PricingConfigError('INVALID', 'Type some codes, or ask for random ones.');
    }

    const created = await this.db.transaction(async (tx) => {
      const out: string[] = [];
      for (let i = 0; i < codes.length; i += 500) {
        const rows = await tx
          .insert(discountCoupons)
          .values(
            codes.slice(i, i + 500).map((code) => ({
              companyId,
              ruleId,
              code,
              validFrom: input.validFrom ?? new Date(),
              validTo: input.validTo ?? null,
              maxUses: input.maxUses ?? null,
              maxUsesPerCustomer: input.maxUsesPerCustomer ?? null,
              createdBy: actor.id ?? 'system',
            })),
          )
          .onConflictDoNothing()
          .returning({ code: discountCoupons.code });
        out.push(...rows.map((r) => r.code));
      }
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'discount_rule', id: ruleId },
          action: 'pricing.coupons_created',
          reason: why,
          outcome: { created: out.length, sample: out.slice(0, 10), rule: rule.code },
        },
        tx,
      );
      return out;
    });
    this.discounts.invalidate(companyId);
    return { created };
  }

  async setCouponStatus(
    companyId: string,
    couponId: string,
    status: 'active' | 'disabled',
    actor: Actor,
    reason: Why,
  ) {
    const why = await this.why(companyId, reason);
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(discountCoupons)
        .set({ status })
        .where(and(eq(discountCoupons.companyId, companyId), eq(discountCoupons.id, couponId)))
        .returning();
      if (!row) throw new PricingConfigError('NOT_FOUND', 'That coupon does not exist.');
      await this.decisions.record(
        {
          companyId,
          actor,
          subject: { type: 'discount_rule', id: row.ruleId },
          action: 'pricing.coupon_changed',
          reason: why,
          outcome: { code: row.code, status },
        },
        tx,
      );
    });
  }

  // ── Simulator ────────────────────────────────────────────────────────────

  /** Prices a basket as a sale would be, discounts included, and says why each rule did or did not apply. */
  async simulate(companyId: string, input: SimulationInput): Promise<SimulationResult> {
    if (input.lines.length === 0)
      throw new PricingConfigError('INVALID', 'Add at least one product.');
    if (input.lines.length > 100)
      throw new PricingConfigError('TOO_MANY', 'Try at most 100 products at once.');
    const rows = await this.db
      .select()
      .from(products)
      .where(
        inArray(
          products.id,
          input.lines.map((l) => l.productId),
        ),
      );
    const byId = new Map(rows.map((p) => [p.id, p]));
    const sale = {
      at: input.at ?? new Date(),
      customerId: input.customerId ?? null,
      salesType: input.salesType ?? 'cash',
      channel: input.channel ?? 'sales_order',
      paymentMethod: input.paymentMethod ?? null,
    };
    const priceable = input.lines.filter((l) => byId.has(l.productId) && l.quantity > 0);
    const priced = await this.pricing.priceLines(
      companyId,
      sale,
      priceable.map((l) => {
        const p = byId.get(l.productId)!;
        const inclusive = p.isTaxInclusive !== false;
        return {
          productId: l.productId,
          quantity: l.quantity,
          standardPrice: p.price == null ? null : Number(p.price),
          taxRate: p.taxRate == null ? 0 : Number(p.taxRate),
          lineTaxInclusive: inclusive,
          standardTaxInclusive: inclusive,
        };
      }),
    );
    const items: PricedItem[] = [];
    const slot = new Map<number, number>();
    priceable.forEach((l, i) => {
      const r = priced[i]!;
      if (r.unitPrice == null || r.lineTotal == null) return;
      const p = byId.get(l.productId)!;
      slot.set(i, items.length);
      items.push({
        productId: l.productId,
        quantity: l.quantity,
        unitPrice: r.unitPrice,
        lineTotal: r.lineTotal,
        taxRate: p.taxRate == null ? 0 : Number(p.taxRate),
        lineTaxInclusive: p.isTaxInclusive !== false,
        explicitFloorUnit: r.trace.floorPrice ?? null,
        trace: r.trace,
      });
    });
    let tryRow: DiscountRuleRow | undefined;
    if (input.tryRuleId) tryRow = await this.getRule(companyId, input.tryRuleId);
    const basket: BasketDiscounts = await this.discounts.evaluate(companyId, sale, items, {
      couponCodes: input.couponCodes,
      asIfActive: tryRow ? [{ ...tryRow, status: 'active' }] : undefined,
    });

    let totalBefore = 0;
    let totalAfter = 0;
    const lines = input.lines.map((l) => {
      const p = byId.get(l.productId);
      const at = priceable.indexOf(l);
      const pr = at >= 0 ? priced[at]! : null;
      const k = at >= 0 ? slot.get(at) : undefined;
      if (!p || !pr || pr.unitPrice == null || k == null) {
        return {
          productId: l.productId,
          name: p?.name ?? l.productId,
          quantity: l.quantity,
          unitPriceBefore: null,
          unitPriceAfter: null,
          lineTotalBefore: null,
          lineTotalAfter: null,
          problem: !p
            ? 'That product does not exist.'
            : (pr?.trace.steps.at(-1) ?? 'This line cannot be priced.'),
          applied: [],
          considered: [],
        };
      }
      const b = basket.lines[k]!;
      totalBefore += b.lineTotalBefore;
      totalAfter += b.lineTotalAfter;
      return {
        productId: l.productId,
        name: p.name,
        quantity: l.quantity,
        unitPriceBefore: b.unitPriceBefore,
        unitPriceAfter: b.unitPriceAfter,
        lineTotalBefore: b.lineTotalBefore,
        lineTotalAfter: b.lineTotalAfter,
        problem: null,
        applied: b.trace.applied.map((a) => ({
          code: a.code,
          name: a.name,
          level: a.level,
          amount: a.amount,
          how: a.how,
        })),
        // Rules that were never about this product add nothing, except the one being tried.
        considered: b.considered
          .filter(
            (c) =>
              c.ruleId === tryRow?.id ||
              !(
                c.why.startsWith('Not for this product') ||
                c.why.startsWith('Only for a different') ||
                c.why.startsWith('Excludes this')
              ),
          )
          .map((c) => ({ code: c.code, outcome: c.outcome, why: c.why })),
      };
    });
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      lines,
      totalBefore: r2(totalBefore),
      totalAfter: r2(totalAfter),
      totalDiscount: r2(totalBefore - totalAfter),
      couponProblems: basket.couponProblems,
      orderConsidered: basket.orderConsidered.map((c) => ({
        code: c.code,
        outcome: c.outcome,
        why: c.why,
      })),
      gifts: basket.gifts.map((g) => ({
        code: g.code,
        ruleName: g.ruleName,
        productName: g.productName,
        quantity: g.quantity,
        value: g.value,
      })),
    };
  }

  /** Rules that look like duplicates of each other, for the quality check shown before activation. */
  async overlaps(companyId: string, id: string): Promise<string[]> {
    const me = await this.getRule(companyId, id);
    const others = await this.db
      .select()
      .from(discountRules)
      .where(
        and(
          eq(discountRules.companyId, companyId),
          eq(discountRules.status, 'active'),
          ne(discountRules.id, id),
          eq(discountRules.kind, me.kind as DiscountKind),
        ),
      );
    const a = toRule(me);
    return others
      .map(toRule)
      .filter(
        (o) =>
          o.stacking === 'exclusive' &&
          a.stacking === 'exclusive' &&
          JSON.stringify(o.target) === JSON.stringify(a.target) &&
          JSON.stringify(o.scopes) === JSON.stringify(a.scopes) &&
          o.requiresCoupon === a.requiresCoupon,
      )
      .map((o) => o.code);
  }
}

export type { Tx };
