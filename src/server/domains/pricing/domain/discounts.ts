import type { MixConfig } from './mix';
import { scopeMismatch } from './resolve';
import type { Scopes } from './types';

/**
 * Discount rules (P-2): reductions applied after the base price has been chosen. Pure functions
 * over a snapshot, so the same inputs always give the same answer and every decision can be
 * explained. See docs/architecture/pricing-module.md section 4.
 *
 * The order of work is fixed, so results never depend on the order rules were created in:
 *   1. line rules, each line on its own;
 *   2. order rules, on what the lines now come to;
 *   3. guards last: nothing is taken below a product's floor, a rule's own cap or its budget.
 */

/**
 * `line` and `order` reduce a price. `mix` is a deal across units (buy-and-get, mix-and-match,
 * bundle deal) and `gift` adds a free item; both are described by `mix`.
 */
export type DiscountKind = 'line' | 'order' | 'mix' | 'gift';
export type DiscountStatus = 'draft' | 'active' | 'paused' | 'retired';
/**
 * `exclusive`: competes with the other exclusive rules, and only the best one applies.
 * `stackable`: combines with other stackable rules, one after another.
 * Where both kinds are eligible, the exclusive winner and the whole stackable set are compared and
 * the customer gets whichever is worth more, never both.
 */
export type Stacking = 'exclusive' | 'stackable';

/** What a mix or gift rule carries in place of a reward: they are described by their deal. */
export const NO_REWARD: DiscountReward = { type: 'percent', value: 0 };

export type LineRewardType = 'percent' | 'amount_per_unit' | 'amount_per_line' | 'set_price';
export type OrderRewardType = 'percent' | 'amount';

/** A step in a reward: from this quantity (line rules) or order value (order rules) up. */
export interface RewardTier {
  from: number;
  value: number;
}
export interface DiscountReward {
  type: LineRewardType | OrderRewardType;
  value: number;
  /** The highest tier reached replaces `value`. */
  tiers?: RewardTier[];
}

/** What a rule can apply to. Empty or `all` means every product. */
export interface DiscountTarget {
  all?: boolean;
  categoryIds?: string[];
  brands?: string[];
  productGroupIds?: string[];
  productIds?: string[];
}

/** Days of the week (0 = Sunday) and a daily time window, in the business time zone. */
export interface DiscountSchedule {
  days?: number[];
  from?: string;
  to?: string;
}

export interface DiscountConditions {
  /** Line rules: units of the line. */
  minQuantity?: number;
  /** Order rules: what the matching lines come to. */
  minOrderValue?: number;
  paymentMethods?: string[];
}

export interface DiscountLimits {
  maxUses?: number;
  maxUsesPerCustomer?: number;
  /** The most this rule may give away, in total. */
  budget?: number;
  /** The most this rule may take off a line, as a percentage of the line. */
  maxDiscountPercent?: number;
}

export interface DiscountRule {
  id: string;
  code: string;
  name: string;
  kind: DiscountKind;
  priority: number;
  stacking: Stacking;
  validFrom: Date;
  validTo: Date | null;
  schedule: DiscountSchedule;
  scopes: Scopes;
  target: DiscountTarget;
  conditions: DiscountConditions;
  reward: DiscountReward;
  requiresCoupon: boolean;
  limits: DiscountLimits;
  /** May this rule also reduce a line priced by a contract price list? */
  appliesToContract: boolean;
  /** The deal, for `mix` and `gift` rules. */
  mix?: MixConfig | null;
  version: number;
}

export interface DiscountProduct {
  id: string;
  brand: string | null;
  /** The product's category first, then each category above it. */
  categoryChain: string[];
  groupIds: string[];
}

/** A line as discounts see it. Amounts are in the line's own tax basis, in the sale's currency. */
export interface DiscountLine extends DiscountProduct {
  index: number;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  /** The least this line may come to (its floor); null when it has none. */
  minLineTotal: number | null;
  /** Priced by a contract price list. */
  contractPriced: boolean;
}

export interface DiscountContext {
  at: Date;
  timeZone?: string;
  customerId?: string | null;
  customerGroupId?: string | null;
  branchId?: string | null;
  salesType?: string | null;
  channel?: string | null;
  paymentMethod?: string | null;
}

/** What the database says about a rule right now. */
export interface RuleAvailability {
  /** Why it cannot be used at all (uses or budget used up, customer's limit reached). */
  blocked?: string;
  /** What is left of its budget. Null for no budget. */
  remainingBudget: number | null;
}

/** Everything the resolution reads besides the lines themselves. */
export interface DiscountInputs {
  rules: DiscountRule[];
  /** Rules unlocked by a coupon the customer gave, by rule id. */
  unlockedByCoupon: Map<string, string>;
  availability: Map<string, RuleAvailability>;
  ctx: DiscountContext;
}

export interface AppliedDiscount {
  ruleId: string;
  code: string;
  name: string;
  /** Taken off, in the line's currency and basis. */
  amount: number;
  /** In words: "10% off", "KES 50 off each". */
  how: string;
  couponCode?: string;
}

/** What happened to a rule that was looked at but did not reduce the line. */
export interface Considered {
  ruleId: string;
  code: string;
  outcome: 'applied' | 'lost' | 'not_applicable' | 'blocked';
  why: string;
}

export interface LineDiscountResult {
  index: number;
  applied: AppliedDiscount[];
  total: number;
  /** Taken back because the line would have gone below its floor. */
  trimmed: number;
  considered: Considered[];
}

export interface OrderDiscountResult {
  applied: AppliedDiscount[];
  total: number;
  trimmed: number;
  /** How much of each line's current total comes off, as a percentage, by line index. */
  linePercent: Map<number, number>;
  considered: Considered[];
}

const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

// ── Eligibility ──────────────────────────────────────────────────────────────

const parseTime = (hhmm: string) => {
  const [h = '0', m = '0'] = hhmm.split(':');
  return Number(h) * 60 + Number(m);
};

/** Day and minute of day at `at` in a time zone. */
export function localParts(at: Date, timeZone = 'Africa/Nairobi') {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** Why the rule is not in force at `at`, or null when it is. */
export function windowProblem(rule: DiscountRule, at: Date, timeZone?: string): string | null {
  if (at.getTime() < rule.validFrom.getTime()) return 'Has not started yet';
  if (rule.validTo && at.getTime() >= rule.validTo.getTime()) return 'Has ended';
  const { days, from, to } = rule.schedule;
  if ((days && days.length > 0) || from || to) {
    const here = localParts(at, timeZone);
    if (days && days.length > 0 && !days.includes(here.day)) return 'Not on this day of the week';
    if (from && to) {
      const a = parseTime(from);
      const b = parseTime(to);
      // A window that runs past midnight (22:00 to 02:00) wraps.
      const inside =
        a <= b ? here.minutes >= a && here.minutes < b : here.minutes >= a || here.minutes < b;
      if (!inside) return `Only between ${from} and ${to}`;
    }
  }
  return null;
}

export function targetMatches(target: DiscountTarget, p: DiscountProduct): boolean {
  const all =
    target.all === true ||
    ((target.categoryIds?.length ?? 0) === 0 &&
      (target.brands?.length ?? 0) === 0 &&
      (target.productGroupIds?.length ?? 0) === 0 &&
      (target.productIds?.length ?? 0) === 0);
  if (all) return true;
  if (target.productIds?.includes(p.id)) return true;
  if (target.productGroupIds?.some((g) => p.groupIds.includes(g))) return true;
  if (
    target.brands?.some(
      (b) => p.brand != null && b.trim().toLowerCase() === p.brand.trim().toLowerCase(),
    )
  )
    return true;
  return target.categoryIds?.some((c) => p.categoryChain.includes(c)) ?? false;
}

/** Everything about a rule that does not depend on the line: validity, scope, coupon, limits. */
export function ruleProblem(rule: DiscountRule, inputs: DiscountInputs): string | null {
  const w = windowProblem(rule, inputs.ctx.at, inputs.ctx.timeZone);
  if (w) return w;
  const scope = scopeMismatch(rule.scopes, {
    at: inputs.ctx.at,
    currency: '',
    baseCurrency: '',
    rateFromBase: 1,
    decimals: 2,
    customerId: inputs.ctx.customerId,
    customerGroupId: inputs.ctx.customerGroupId,
    branchId: inputs.ctx.branchId,
    salesType: inputs.ctx.salesType,
    channel: inputs.ctx.channel,
  });
  if (scope) return scope;
  const pm = rule.conditions.paymentMethods;
  if (pm && pm.length > 0 && !(inputs.ctx.paymentMethod && pm.includes(inputs.ctx.paymentMethod)))
    return 'Only for other payment methods';
  if (rule.requiresCoupon && !inputs.unlockedByCoupon.has(rule.id)) return 'Needs a coupon code';
  const avail = inputs.availability.get(rule.id);
  if (avail?.blocked) return avail.blocked;
  return null;
}

// ── Rewards ──────────────────────────────────────────────────────────────────

/** The reward value that applies at `at` (a quantity or an order value), after tiers. */
export function rewardValue(reward: DiscountReward, at: number): number {
  let v = reward.value;
  const tiers = [...(reward.tiers ?? [])].sort((a, b) => a.from - b.from);
  for (const t of tiers) if (at >= t.from) v = t.value;
  return v;
}

function describeReward(rule: DiscountRule, at: number): string {
  const v = rewardValue(rule.reward, at);
  switch (rule.reward.type) {
    case 'percent':
      return `${v}% off`;
    case 'amount_per_unit':
      return `${v} off each unit`;
    case 'amount_per_line':
    case 'amount':
      return `${v} off`;
    case 'set_price':
      return `priced at ${v}`;
  }
}

/** What a line rule takes off a line, before stacking and guards. */
export function lineBenefit(
  rule: DiscountRule,
  line: Pick<DiscountLine, 'quantity' | 'unitPrice' | 'lineTotal'>,
): number {
  const v = rewardValue(rule.reward, line.quantity);
  let amount = 0;
  switch (rule.reward.type) {
    case 'percent':
      amount = (line.lineTotal * v) / 100;
      break;
    case 'amount_per_unit':
      amount = v * line.quantity;
      break;
    case 'amount_per_line':
      amount = v;
      break;
    case 'set_price':
      amount = Math.max(0, line.unitPrice - v) * line.quantity;
      break;
    default:
      amount = 0;
  }
  const cap =
    rule.limits.maxDiscountPercent != null
      ? (line.lineTotal * rule.limits.maxDiscountPercent) / 100
      : Infinity;
  return round(Math.max(0, Math.min(amount, cap, line.lineTotal)));
}

// ── Stacking ─────────────────────────────────────────────────────────────────

interface Candidate {
  rule: DiscountRule;
  /** What it would take off the current total, on its own. */
  benefit: number;
}

const byBenefit = (a: Candidate, b: Candidate) =>
  b.benefit - a.benefit ||
  b.rule.priority - a.rule.priority ||
  a.rule.code.localeCompare(b.rule.code);
const byPriority = (a: Candidate, b: Candidate) =>
  b.rule.priority - a.rule.priority || a.rule.code.localeCompare(b.rule.code);

interface Chosen {
  steps: Array<{ rule: DiscountRule; amount: number }>;
  total: number;
  lost: Array<{ rule: DiscountRule; why: string }>;
}

/**
 * Picks what applies from the eligible candidates. The best exclusive rule and the stackable set
 * (applied one after another, each on what is left) are compared; the one worth more wins.
 * `benefitOn` works out a rule's benefit against a running total.
 */
function choose(
  candidates: Candidate[],
  total: number,
  benefitOn: (rule: DiscountRule, remaining: number) => number,
): Chosen {
  const exclusive = candidates.filter((c) => c.rule.stacking === 'exclusive').sort(byBenefit);
  const stackable = candidates.filter((c) => c.rule.stacking === 'stackable').sort(byPriority);

  const bestExclusive = exclusive[0];
  const stackSteps: Chosen['steps'] = [];
  let remaining = total;
  for (const c of stackable) {
    const amount = Math.min(benefitOn(c.rule, remaining), remaining);
    if (amount > 0) {
      stackSteps.push({ rule: c.rule, amount });
      remaining = round(remaining - amount);
    }
  }
  const stackTotal = round(stackSteps.reduce((n, s) => n + s.amount, 0));

  // Ties go to the exclusive rule: one reason is easier to explain than several.
  const useExclusive = bestExclusive != null && bestExclusive.benefit >= stackTotal;
  if (useExclusive && bestExclusive.benefit > 0) {
    return {
      steps: [{ rule: bestExclusive.rule, amount: bestExclusive.benefit }],
      total: bestExclusive.benefit,
      lost: [
        ...exclusive.slice(1).map((c) => ({
          rule: c.rule,
          why: `${exclusive[0]!.rule.code} gives the customer more`,
        })),
        ...stackable.map((c) => ({
          rule: c.rule,
          why: `${bestExclusive.rule.code} is worth more than the stackable rules together`,
        })),
      ],
    };
  }
  return {
    steps: stackSteps,
    total: stackTotal,
    lost: [
      ...exclusive.map((c) => ({
        rule: c.rule,
        why:
          stackTotal > 0
            ? 'The stackable rules together give the customer more'
            : 'Gives nothing here',
      })),
      ...stackable
        .filter((c) => !stackSteps.some((s) => s.rule.id === c.rule.id))
        .map((c) => ({ rule: c.rule, why: 'Gives nothing here' })),
    ],
  };
}

/** Scales the amounts down so they add up to `allowed`, keeping their proportions. */
function scaleTo(steps: Chosen['steps'], allowed: number): Chosen['steps'] {
  const sum = steps.reduce((n, s) => n + s.amount, 0);
  if (sum <= allowed || sum === 0) return steps;
  const k = allowed / sum;
  const scaled = steps.map((s) => ({ rule: s.rule, amount: round(s.amount * k) }));
  // Rounding can leave a cent over or under; the last step absorbs it.
  const diff = round(allowed - scaled.reduce((n, s) => n + s.amount, 0));
  if (scaled.length > 0)
    scaled[scaled.length - 1]!.amount = round(scaled[scaled.length - 1]!.amount + diff);
  return scaled.filter((s) => s.amount > 0);
}

// ── Line rules ───────────────────────────────────────────────────────────────

/**
 * Applies the line rules to every line. A rule's budget is shared by all the lines of the
 * document: lines are taken in order and each one uses up what it takes.
 */
export function resolveLineDiscounts(
  lines: DiscountLine[],
  inputs: DiscountInputs,
): LineDiscountResult[] {
  const rules = inputs.rules.filter((r) => r.kind === 'line');
  const remaining = new Map<string, number | null>(
    rules.map((r) => [r.id, inputs.availability.get(r.id)?.remainingBudget ?? null]),
  );
  const rulePrecheck = new Map(rules.map((r) => [r.id, ruleProblem(r, inputs)]));

  return lines.map((line) => {
    const considered: Considered[] = [];
    const candidates: Candidate[] = [];
    for (const rule of rules) {
      const problem = rulePrecheck.get(rule.id) ?? null;
      if (problem) {
        considered.push({
          ruleId: rule.id,
          code: rule.code,
          outcome:
            problem.startsWith('Used up') || problem.includes('limit')
              ? 'blocked'
              : 'not_applicable',
          why: problem,
        });
        continue;
      }
      if (!targetMatches(rule.target, line)) {
        considered.push({
          ruleId: rule.id,
          code: rule.code,
          outcome: 'not_applicable',
          why: 'Not for this product',
        });
        continue;
      }
      if (line.contractPriced && !rule.appliesToContract) {
        considered.push({
          ruleId: rule.id,
          code: rule.code,
          outcome: 'not_applicable',
          why: 'This line has a contract price, which promotions do not reduce',
        });
        continue;
      }
      const min = rule.conditions.minQuantity;
      if (min != null && line.quantity < min) {
        considered.push({
          ruleId: rule.id,
          code: rule.code,
          outcome: 'not_applicable',
          why: `Needs at least ${min} units`,
        });
        continue;
      }
      const budget = remaining.get(rule.id);
      if (budget != null && budget <= 0) {
        considered.push({
          ruleId: rule.id,
          code: rule.code,
          outcome: 'blocked',
          why: 'Used up its budget',
        });
        continue;
      }
      const benefit = Math.min(lineBenefit(rule, line), budget ?? Infinity);
      if (benefit <= 0) {
        considered.push({
          ruleId: rule.id,
          code: rule.code,
          outcome: 'not_applicable',
          why: 'Takes nothing off this line',
        });
        continue;
      }
      candidates.push({ rule, benefit: round(benefit) });
    }

    const chosen = choose(candidates, line.lineTotal, (rule, left) =>
      Math.min(lineBenefit(rule, { ...line, lineTotal: left }), remaining.get(rule.id) ?? Infinity),
    );

    // Guard: never below the floor.
    const slack =
      line.minLineTotal == null ? Infinity : Math.max(0, line.lineTotal - line.minLineTotal);
    const steps = scaleTo(chosen.steps, slack);
    const total = round(steps.reduce((n, s) => n + s.amount, 0));
    const trimmed = round(chosen.total - total);

    for (const s of steps) {
      const left = remaining.get(s.rule.id);
      if (left != null) remaining.set(s.rule.id, round(left - s.amount));
    }
    for (const c of candidates) {
      const used = steps.find((s) => s.rule.id === c.rule.id);
      const lost = chosen.lost.find((l) => l.rule.id === c.rule.id);
      considered.push({
        ruleId: c.rule.id,
        code: c.rule.code,
        outcome: used ? 'applied' : 'lost',
        why: used
          ? trimmed > 0
            ? `Applied, cut back by ${trimmed} so the line stays at or above its floor`
            : 'Applied'
          : (lost?.why ?? 'Cut back to keep the line at or above its floor'),
      });
    }

    return {
      index: line.index,
      applied: steps.map((s) => ({
        ruleId: s.rule.id,
        code: s.rule.code,
        name: s.rule.name,
        amount: s.amount,
        how: describeReward(s.rule, line.quantity),
        couponCode: inputs.unlockedByCoupon.get(s.rule.id),
      })),
      total,
      trimmed,
      considered,
    };
  });
}

// ── Order rules ──────────────────────────────────────────────────────────────

/**
 * Applies the order rules to what the lines now come to. A rule's discount is spread over the
 * lines it covers in proportion to what each costs, so tax and returns stay correct line by line.
 * `lines` carry their totals after the line rules.
 */
export function resolveOrderDiscounts(
  lines: DiscountLine[],
  inputs: DiscountInputs,
): OrderDiscountResult {
  const rules = inputs.rules.filter((r) => r.kind === 'order');
  const considered: Considered[] = [];
  const empty: OrderDiscountResult = {
    applied: [],
    total: 0,
    trimmed: 0,
    linePercent: new Map(),
    considered,
  };
  if (rules.length === 0 || lines.length === 0) return empty;

  // Per rule: the lines it covers and what they come to.
  const covers = new Map<string, DiscountLine[]>();
  const candidates: Candidate[] = [];
  for (const rule of rules) {
    const problem = ruleProblem(rule, inputs);
    if (problem) {
      considered.push({
        ruleId: rule.id,
        code: rule.code,
        outcome:
          problem.startsWith('Used up') || problem.includes('limit') ? 'blocked' : 'not_applicable',
        why: problem,
      });
      continue;
    }
    const mine = lines.filter(
      (l) => targetMatches(rule.target, l) && (!l.contractPriced || rule.appliesToContract),
    );
    const value = round(mine.reduce((n, l) => n + l.lineTotal, 0));
    if (mine.length === 0 || value <= 0) {
      considered.push({
        ruleId: rule.id,
        code: rule.code,
        outcome: 'not_applicable',
        why: 'No matching products in the order',
      });
      continue;
    }
    const min = rule.conditions.minOrderValue;
    if (min != null && value < min) {
      considered.push({
        ruleId: rule.id,
        code: rule.code,
        outcome: 'not_applicable',
        why: `Needs ${min} of matching goods; this order has ${value}`,
      });
      continue;
    }
    const budget = inputs.availability.get(rule.id)?.remainingBudget ?? null;
    const benefit = Math.min(orderBenefit(rule, value), budget ?? Infinity);
    if (benefit <= 0) {
      considered.push({
        ruleId: rule.id,
        code: rule.code,
        outcome: 'not_applicable',
        why: 'Takes nothing off this order',
      });
      continue;
    }
    covers.set(rule.id, mine);
    candidates.push({ rule, benefit: round(benefit) });
  }
  if (candidates.length === 0) return empty;

  // Rules may cover different lines, so they are compared on the order as a whole.
  const orderTotal = round(lines.reduce((n, l) => n + l.lineTotal, 0));
  const chosen = choose(candidates, orderTotal, (rule, left) =>
    Math.min(
      orderBenefit(
        rule,
        round(
          Math.min(
            left,
            covers.get(rule.id)!.reduce((n, l) => n + l.lineTotal, 0),
          ),
        ),
      ),
      inputs.availability.get(rule.id)?.remainingBudget ?? Infinity,
    ),
  );

  // Spread each chosen rule over its lines, one rule after another on what is left of each line.
  const left = new Map(lines.map((l) => [l.index, l.lineTotal]));
  const floor = new Map(lines.map((l) => [l.index, l.minLineTotal ?? 0]));
  const taken = new Map<number, number>();
  const applied: AppliedDiscount[] = [];
  let trimmed = 0;
  for (const step of chosen.steps) {
    const mine = covers.get(step.rule.id)!;
    const base = mine.reduce((n, l) => n + (left.get(l.index) ?? 0), 0);
    let given = 0;
    if (base > 0) {
      const p = Math.min(step.amount / base, 1);
      mine.forEach((l, i) => {
        const have = left.get(l.index) ?? 0;
        const slack = Math.max(0, have - (floor.get(l.index) ?? 0));
        const want = i === mine.length - 1 ? round(step.amount - given) : round(have * p);
        const cut = round(Math.max(0, Math.min(want, slack, have)));
        left.set(l.index, round(have - cut));
        taken.set(l.index, round((taken.get(l.index) ?? 0) + cut));
        given = round(given + cut);
      });
    }
    trimmed = round(trimmed + (step.amount - given));
    if (given > 0)
      applied.push({
        ruleId: step.rule.id,
        code: step.rule.code,
        name: step.rule.name,
        amount: given,
        how: describeReward(step.rule, round(base)),
        couponCode: inputs.unlockedByCoupon.get(step.rule.id),
      });
  }

  for (const c of candidates) {
    const used = applied.find((a) => a.ruleId === c.rule.id);
    const lost = chosen.lost.find((l) => l.rule.id === c.rule.id);
    considered.push({
      ruleId: c.rule.id,
      code: c.rule.code,
      outcome: used ? 'applied' : 'lost',
      why: used
        ? trimmed > 0
          ? `Applied, cut back by ${trimmed} so no line goes below its floor`
          : 'Applied'
        : (lost?.why ?? 'Cut back to keep every line at or above its floor'),
    });
  }

  const linePercent = new Map<number, number>();
  for (const l of lines) {
    const t = taken.get(l.index) ?? 0;
    if (t > 0 && l.lineTotal > 0) linePercent.set(l.index, round((t / l.lineTotal) * 100, 6));
  }
  return {
    applied,
    total: round(applied.reduce((n, a) => n + a.amount, 0)),
    trimmed,
    linePercent,
    considered,
  };
}

/** What an order rule takes off `value` of covered goods, before stacking and guards. */
export function orderBenefit(rule: DiscountRule, value: number): number {
  const v = rewardValue(rule.reward, value);
  const amount = rule.reward.type === 'percent' ? (value * v) / 100 : v;
  const cap =
    rule.limits.maxDiscountPercent != null
      ? (value * rule.limits.maxDiscountPercent) / 100
      : Infinity;
  return round(Math.max(0, Math.min(amount, cap, value)));
}
