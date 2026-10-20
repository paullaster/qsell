import {
  ruleProblem,
  targetMatches,
  type AppliedDiscount,
  type Considered,
  type DiscountInputs,
  type DiscountLine,
  type DiscountRule,
  type DiscountTarget,
} from './discounts';

/**
 * Product-mix promotions (P-3): buy-and-get, mix-and-match, bundle deals, and free gifts. These
 * work on units rather than lines, so they are decided here, over a snapshot, with the same rule
 * as everything else in the engine: the same inputs always give the same answer.
 *
 * Unit allocation: a unit is claimed by at most one mix promotion. Promotions are taken in the
 * order that is worth most to the customer at each step (ties: higher priority, then the lower
 * code), each claiming the units it needs, so no unit earns two promotions.
 */

export type MixRewardKind = 'free' | 'percent' | 'price';

/** One side of a deal: some units of a set of products. */
export interface MixSlot {
  target: DiscountTarget;
  quantity: number;
}

export type MixConfig =
  /**
   * Buy some units, get some units at a reward. With `sameSet` the units come from one set and
   * the cheapest of each group of (buy + get) earn the reward ("buy 2 get the cheapest free").
   */
  | {
      type: 'buy_get';
      buy: MixSlot;
      get: MixSlot & {
        reward: { kind: MixRewardKind; value?: number };
        pick?: 'cheapest' | 'most_expensive';
      };
      sameSet?: boolean;
      maxSets?: number;
    }
  /** Any `quantity` units from a set for a set price in all, or a percentage off. */
  | {
      type: 'mix_match';
      set: DiscountTarget;
      quantity: number;
      reward: { kind: 'price' | 'percent'; value: number };
      maxSets?: number;
    }
  /** One unit group from each slot together for a fixed price (burger + fries + drink). */
  | { type: 'bundle_deal'; slots: MixSlot[]; price: number; maxSets?: number }
  /** A free item (or items) added once the goods in the order come to enough. */
  | {
      type: 'gift';
      trigger: { minOrderValue?: number; minQuantity?: number; target?: DiscountTarget };
      gifts: Array<{ productId: string; quantity: number }>;
    };

export const MIX_TYPES = ['buy_get', 'mix_match', 'bundle_deal', 'gift'] as const;
/** The most units one document is expanded into; a larger basket is not given mix promotions. */
export const MAX_UNITS = 5000;
/** Most gift lines or kinds of unit in one deal. */
export const MAX_GIFT_KINDS = 10;

const round = (n: number, dp = 2) => Math.round((n + Number.EPSILON) * 10 ** dp) / 10 ** dp;

interface Unit {
  /** Which line, and which unit of it. */
  line: number;
  n: number;
  price: number;
  source: DiscountLine;
}
const keyOf = (u: Pick<Unit, 'line' | 'n'>) => `${u.line}:${u.n}`;

interface Claim {
  unit: Unit;
  discount: number;
}
interface Plan {
  rule: DiscountRule;
  claims: Claim[];
  /** Units used without a discount (the "buy" side of a deal). */
  holds: Unit[];
  benefit: number;
  sets: number;
  how: string;
}

export interface MixLineResult {
  index: number;
  applied: AppliedDiscount[];
  total: number;
  trimmed: number;
}
export interface MixResult {
  lines: Map<number, MixLineResult>;
  considered: Considered[];
}

/** Splits `take` over units in proportion to their prices, to the cent, so the parts add up exactly. */
function spread(take: number, group: Unit[]): Claim[] {
  const worth = group.reduce((n, u) => n + u.price, 0);
  if (worth <= 0 || take <= 0) return group.map((unit) => ({ unit, discount: 0 }));
  let given = 0;
  return group.map((unit, i) => {
    const discount =
      i === group.length - 1 ? round(take - given) : round((take * unit.price) / worth);
    given = round(given + discount);
    return { unit, discount };
  });
}

const cheapestFirst = (a: Unit, b: Unit) => a.price - b.price || a.line - b.line || a.n - b.n;
const dearestFirst = (a: Unit, b: Unit) => cheapestFirst(b, a);

function unitsOf(lines: DiscountLine[]): Unit[] {
  const out: Unit[] = [];
  for (const l of lines) {
    const count = Math.floor(l.quantity);
    if (count < 1 || l.lineTotal <= 0) continue;
    const price = l.lineTotal / l.quantity;
    for (let n = 0; n < count; n++) out.push({ line: l.index, n, price, source: l });
  }
  return out;
}

/** Whether a line has a part unit left over (the 0.5 of 2.5 kg), which no deal counts. */
const hasPartUnit = (l: DiscountLine) =>
  Math.round((l.quantity - Math.floor(l.quantity)) * 1000) > 0;

const rewardOn = (reward: { kind: MixRewardKind; value?: number }, price: number) =>
  reward.kind === 'free'
    ? price
    : reward.kind === 'percent'
      ? (price * (reward.value ?? 0)) / 100
      : Math.max(0, price - (reward.value ?? 0));

const describeBuyGet = (c: Extract<MixConfig, { type: 'buy_get' }>) => {
  const r = c.get.reward;
  const what =
    r.kind === 'free' ? 'free' : r.kind === 'percent' ? `${r.value}% off` : `at ${r.value} each`;
  return `buy ${c.buy.quantity}, get ${c.get.quantity} ${what}`;
};

/** The units a deal would use and what it would take off, given the units still free. */
function plan(rule: DiscountRule, config: MixConfig, free: Unit[]): Plan | null {
  const empty = (how: string): Plan => ({ rule, claims: [], holds: [], benefit: 0, sets: 0, how });
  switch (config.type) {
    case 'buy_get': {
      const buyUnits = free.filter((u) => targetMatches(config.buy.target, u.source));
      const how = describeBuyGet(config);
      if (config.sameSet) {
        const group = config.buy.quantity + config.get.quantity;
        const sorted = [...buyUnits].sort(dearestFirst);
        let sets = Math.floor(sorted.length / group);
        if (config.maxSets != null) sets = Math.min(sets, config.maxSets);
        const claims: Claim[] = [];
        const holds: Unit[] = [];
        for (let s = 0; s < sets; s++) {
          const chunk = sorted.slice(s * group, (s + 1) * group);
          holds.push(...chunk.slice(0, config.buy.quantity));
          for (const u of chunk.slice(config.buy.quantity))
            claims.push({ unit: u, discount: round(rewardOn(config.get.reward, u.price)) });
        }
        const benefit = round(claims.reduce((n, c) => n + c.discount, 0));
        return { rule, claims, holds, benefit, sets, how };
      }
      const getUnits = free.filter(
        (u) => targetMatches(config.get.target, u.source) && !buyUnits.includes(u),
      );
      // A unit that could be either is used as a reward, not as the thing that earns it.
      const onlyBuy = buyUnits.filter((u) => !getUnits.includes(u));
      let sets = Math.min(
        Math.floor(onlyBuy.length / config.buy.quantity),
        Math.floor(getUnits.length / config.get.quantity),
      );
      if (config.maxSets != null) sets = Math.min(sets, config.maxSets);
      if (sets < 1) return empty(how);
      const triggers = [...onlyBuy].sort(cheapestFirst).slice(0, sets * config.buy.quantity);
      const rewards = [...getUnits]
        .sort(config.get.pick === 'most_expensive' ? dearestFirst : cheapestFirst)
        .slice(0, sets * config.get.quantity);
      const claims = rewards.map((u) => ({
        unit: u,
        discount: round(rewardOn(config.get.reward, u.price)),
      }));
      return {
        rule,
        claims,
        holds: triggers,
        benefit: round(claims.reduce((n, c) => n + c.discount, 0)),
        sets,
        how,
      };
    }
    case 'mix_match': {
      const set = free.filter((u) => targetMatches(config.set, u.source)).sort(dearestFirst);
      let sets = Math.floor(set.length / config.quantity);
      if (config.maxSets != null) sets = Math.min(sets, config.maxSets);
      const how =
        config.reward.kind === 'price'
          ? `${config.quantity} for ${config.reward.value}`
          : `${config.quantity} for ${config.reward.value}% off`;
      if (sets < 1) return empty(how);
      const claims: Claim[] = [];
      for (let s = 0; s < sets; s++) {
        const group = set.slice(s * config.quantity, (s + 1) * config.quantity);
        const worth = group.reduce((n, u) => n + u.price, 0);
        const take =
          config.reward.kind === 'price'
            ? Math.max(0, worth - config.reward.value)
            : (worth * config.reward.value) / 100;
        // Spread over the group's units in proportion to what each costs.
        claims.push(...spread(take, group));
      }
      return {
        rule,
        claims,
        holds: [],
        benefit: round(claims.reduce((n, c) => n + c.discount, 0)),
        sets,
        how,
      };
    }
    case 'bundle_deal': {
      const how = `bundle deal at ${config.price}`;
      const used = new Set<string>();
      const claims: Claim[] = [];
      let sets = 0;
      // Fill one group at a time, each slot from the units still free; a unit fills one slot only.
      while (sets < (config.maxSets ?? Infinity)) {
        const group: Unit[] = [];
        const taken = new Set<string>();
        let complete = true;
        for (const slot of config.slots) {
          const pool = free
            .filter(
              (u) =>
                targetMatches(slot.target, u.source) && !used.has(keyOf(u)) && !taken.has(keyOf(u)),
            )
            .sort(dearestFirst);
          if (pool.length < slot.quantity) {
            complete = false;
            break;
          }
          for (const u of pool.slice(0, slot.quantity)) {
            taken.add(keyOf(u));
            group.push(u);
          }
        }
        if (!complete) break;
        for (const k of taken) used.add(k);
        sets++;
        const worth = group.reduce((n, u) => n + u.price, 0);
        const take = Math.max(0, worth - config.price);
        claims.push(...spread(take, group));
      }
      if (sets < 1) return empty(how);
      return {
        rule,
        claims,
        holds: [],
        benefit: round(claims.reduce((n, c) => n + c.discount, 0)),
        sets,
        how,
      };
    }
    case 'gift':
      return null;
  }
}

/** Said once a deal used a line that has a part unit: deals count whole units only. */
function partNote(p: Plan, byIndex: Map<number, DiscountLine>): string {
  const touched = [...p.claims.map((c) => c.unit), ...p.holds].some((u) => {
    const l = byIndex.get(u.line);
    return l !== undefined && hasPartUnit(l);
  });
  return touched ? '. Deals count whole units; a part unit is priced as usual' : '';
}

/**
 * Applies the mix promotions to the lines (carrying whatever the line rules already took off).
 * `lines` hold their totals after the line rules; the discounts here are on top, and never take
 * a line below its floor or a rule past its budget.
 */
export function resolveMixDiscounts(lines: DiscountLine[], inputs: DiscountInputs): MixResult {
  const considered: Considered[] = [];
  const out: MixResult = { lines: new Map(), considered };
  const rules = inputs.rules.filter(
    (r) => r.kind === 'mix' && r.mix != null && r.mix.type !== 'gift',
  );
  if (rules.length === 0) return out;

  const eligible: DiscountRule[] = [];
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
    } else eligible.push(rule);
  }
  if (eligible.length === 0) return out;

  const units = unitsOf(lines);
  if (units.length > MAX_UNITS) {
    for (const r of eligible)
      considered.push({
        ruleId: r.id,
        code: r.code,
        outcome: 'not_applicable',
        why: `The basket has more than ${MAX_UNITS} units, which is too many to match promotions against`,
      });
    return out;
  }

  const claimed = new Set<string>();
  const remaining = new Map(
    eligible.map((r) => [r.id, inputs.availability.get(r.id)?.remainingBudget ?? null]),
  );
  const left = [...eligible];
  const chosen: Plan[] = [];

  // Take the promotion worth most to the customer, claim its units, and look again.
  while (left.length > 0) {
    const free = units.filter((u) => !claimed.has(keyOf(u)));
    const plans = left
      .map((rule) => plan(rule, rule.mix!, free))
      .filter((p): p is Plan => p != null);
    const worthy = plans.filter((p) => p.benefit > 0);
    if (worthy.length === 0) {
      for (const p of plans)
        considered.push({
          ruleId: p.rule.id,
          code: p.rule.code,
          outcome: 'not_applicable',
          why: 'The basket does not have the products it needs, or the deal gives nothing here',
        });
      break;
    }
    worthy.sort(
      (a, b) =>
        b.benefit - a.benefit ||
        b.rule.priority - a.rule.priority ||
        a.rule.code.localeCompare(b.rule.code),
    );
    const best = worthy[0]!;
    chosen.push(best);
    for (const c of best.claims) claimed.add(keyOf(c.unit));
    for (const h of best.holds) claimed.add(keyOf(h));
    left.splice(left.indexOf(best.rule), 1);
    // Rules that gave nothing at all this round are dropped and explained.
    for (const p of plans) {
      if (p.benefit <= 0 && left.includes(p.rule)) {
        left.splice(left.indexOf(p.rule), 1);
        considered.push({
          ruleId: p.rule.id,
          code: p.rule.code,
          outcome: 'not_applicable',
          why: 'The basket does not have the products it needs, or the deal gives nothing here',
        });
      }
    }
  }

  // Amounts per line per rule, held to the rule's budget, then to each line's floor.
  const perLine = new Map<number, Array<{ rule: DiscountRule; how: string; amount: number }>>();
  for (const p of chosen) {
    let budget = remaining.get(p.rule.id) ?? Infinity;
    const byLine = new Map<number, number>();
    for (const c of p.claims) byLine.set(c.unit.line, (byLine.get(c.unit.line) ?? 0) + c.discount);
    const total = [...byLine.values()].reduce((n, x) => n + x, 0);
    const k = total > budget ? budget / total : 1;
    for (const [line, amount] of byLine) {
      const give = round(Math.min(amount * k, budget));
      budget = round(budget - give);
      if (give > 0) {
        const list = perLine.get(line) ?? [];
        list.push({ rule: p.rule, how: p.how, amount: give });
        perLine.set(line, list);
      }
    }
    remaining.set(p.rule.id, budget === Infinity ? null : budget);
  }

  const byIndex = new Map(lines.map((l) => [l.index, l]));
  for (const [index, entries] of perLine) {
    const line = byIndex.get(index)!;
    const slack =
      line.minLineTotal == null ? Infinity : Math.max(0, line.lineTotal - line.minLineTotal);
    const sum = entries.reduce((n, e) => n + e.amount, 0);
    const k = sum > slack ? slack / sum : 1;
    const applied: AppliedDiscount[] = entries
      .map((e) => ({
        ruleId: e.rule.id,
        code: e.rule.code,
        name: e.rule.name,
        amount: round(e.amount * k),
        how: e.how,
        couponCode: inputs.unlockedByCoupon.get(e.rule.id),
      }))
      .filter((a) => a.amount > 0);
    const total = round(applied.reduce((n, a) => n + a.amount, 0));
    out.lines.set(index, { index, applied, total, trimmed: round(sum - total) });
  }

  for (const p of chosen) {
    const gave = [...out.lines.values()].some((l) => l.applied.some((a) => a.ruleId === p.rule.id));
    considered.push({
      ruleId: p.rule.id,
      code: p.rule.code,
      outcome: gave ? 'applied' : 'lost',
      why: gave
        ? `${p.sets} set${p.sets === 1 ? '' : 's'}: ${p.how}${partNote(p, byIndex)}`
        : "Cut back to keep every line at or above its floor, or to the rule's budget",
    });
  }
  return out;
}

// ── Gifts ────────────────────────────────────────────────────────────────────

export interface GiftResult {
  ruleId: string;
  code: string;
  name: string;
  gifts: Array<{ productId: string; quantity: number }>;
}

/**
 * Which free-gift rules the basket has earned. `lines` carry their totals after every discount,
 * so a gift for "spend 20,000" is judged on what the customer actually pays.
 */
export function resolveGifts(
  lines: DiscountLine[],
  inputs: DiscountInputs,
): { gifts: GiftResult[]; considered: Considered[] } {
  const considered: Considered[] = [];
  const gifts: GiftResult[] = [];
  for (const rule of inputs.rules) {
    if (rule.kind !== 'gift' || rule.mix?.type !== 'gift') continue;
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
    const t = rule.mix.trigger;
    const mine = lines.filter(
      (l) => targetMatches(t.target ?? {}, l) && (!l.contractPriced || rule.appliesToContract),
    );
    const value = round(mine.reduce((n, l) => n + l.lineTotal, 0));
    // Goods sold by weight or length count exactly (2.5 kg is 2.5), not as 2.
    const qty = Math.round(mine.reduce((n, l) => n + l.quantity, 0) * 1000) / 1000;
    if (mine.length === 0 || value <= 0) {
      considered.push({
        ruleId: rule.id,
        code: rule.code,
        outcome: 'not_applicable',
        why: 'No matching products in the order',
      });
      continue;
    }
    if (t.minOrderValue != null && value < t.minOrderValue) {
      considered.push({
        ruleId: rule.id,
        code: rule.code,
        outcome: 'not_applicable',
        why: `Needs ${t.minOrderValue} of matching goods; this order has ${value}`,
      });
      continue;
    }
    if (t.minQuantity != null && qty < t.minQuantity) {
      considered.push({
        ruleId: rule.id,
        code: rule.code,
        outcome: 'not_applicable',
        why: `Needs at least ${t.minQuantity} matching units; this order has ${qty}`,
      });
      continue;
    }
    gifts.push({ ruleId: rule.id, code: rule.code, name: rule.name, gifts: rule.mix.gifts });
    considered.push({
      ruleId: rule.id,
      code: rule.code,
      outcome: 'applied',
      why: 'Earns a free gift',
    });
  }
  return { gifts, considered };
}

// ── Checking a deal ──────────────────────────────────────────────────────────

export interface MixProblem {
  path: string;
  message: string;
}

const isCount = (n: unknown, min = 1) => typeof n === 'number' && Number.isInteger(n) && n >= min;
const hasSelector = (t: DiscountTarget | undefined) =>
  !!t &&
  ((t.categoryIds?.length ?? 0) > 0 ||
    (t.brands?.length ?? 0) > 0 ||
    (t.productGroupIds?.length ?? 0) > 0 ||
    (t.productIds?.length ?? 0) > 0);

/** What is wrong with a deal's settings on their own, and what is only worth a second look. */
export function checkMix(mix: MixConfig): { errors: MixProblem[]; warnings: MixProblem[] } {
  const errors: MixProblem[] = [];
  const warnings: MixProblem[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const maxSetsOk = (n: number | undefined, path: string) => {
    if (n != null && !isCount(n)) err(path, 'The most sets must be a whole number above zero.');
  };
  switch (mix.type) {
    case 'buy_get': {
      if (!isCount(mix.buy.quantity))
        err('mix.buy.quantity', 'Buy: a whole number of units, at least 1.');
      if (!isCount(mix.get.quantity))
        err('mix.get.quantity', 'Get: a whole number of units, at least 1.');
      const r = mix.get.reward;
      if (!['free', 'percent', 'price'].includes(r.kind))
        err('mix.get.reward', 'Choose what the reward is.');
      if (r.kind === 'percent' && !((r.value ?? 0) > 0 && (r.value ?? 0) <= 100))
        err('mix.get.reward', 'A percentage must be more than 0 and at most 100.');
      if (r.kind === 'price' && !((r.value ?? -1) >= 0))
        err('mix.get.reward', 'The price must be zero or more.');
      maxSetsOk(mix.maxSets, 'mix.maxSets');
      if (!mix.sameSet && !hasSelector(mix.get.target) && hasSelector(mix.buy.target))
        warnings.push({
          path: 'mix.get.target',
          message:
            'Nothing limits what can be the reward, so any other product in the basket can earn it.',
        });
      break;
    }
    case 'mix_match': {
      if (!isCount(mix.quantity, 2)) err('mix.quantity', 'A group is at least 2 units.');
      const r = mix.reward;
      if (r.kind === 'price' && !(r.value > 0))
        err('mix.reward', 'The price for the group must be more than zero.');
      if (r.kind === 'percent' && !(r.value > 0 && r.value <= 100))
        err('mix.reward', 'A percentage must be more than 0 and at most 100.');
      if (!['price', 'percent'].includes(r.kind))
        err('mix.reward', 'Choose a price or a percentage.');
      maxSetsOk(mix.maxSets, 'mix.maxSets');
      break;
    }
    case 'bundle_deal': {
      if (mix.slots.length < 2 || mix.slots.length > 6)
        err('mix.slots', 'A bundle deal has 2 to 6 parts.');
      mix.slots.forEach((slot, i) => {
        if (!hasSelector(slot.target))
          err(`mix.slots.${i}`, `Part ${i + 1}: choose which products can fill it.`);
        if (!isCount(slot.quantity))
          err(`mix.slots.${i}`, `Part ${i + 1}: a whole number of units, at least 1.`);
      });
      if (!(mix.price > 0)) err('mix.price', 'The bundle price must be more than zero.');
      maxSetsOk(mix.maxSets, 'mix.maxSets');
      break;
    }
    case 'gift': {
      if (mix.gifts.length < 1 || mix.gifts.length > MAX_GIFT_KINDS)
        err('mix.gifts', `Give between 1 and ${MAX_GIFT_KINDS} gifts.`);
      const seen = new Set<string>();
      mix.gifts.forEach((g, i) => {
        if (!g.productId) err(`mix.gifts.${i}`, `Gift ${i + 1}: choose a product.`);
        if (seen.has(g.productId))
          err(`mix.gifts.${i}`, `Gift ${i + 1}: the same product is listed twice.`);
        seen.add(g.productId);
        if (!isCount(g.quantity))
          err(`mix.gifts.${i}`, `Gift ${i + 1}: a whole number of units, at least 1.`);
      });
      const t = mix.trigger;
      if (t.minOrderValue != null && !(t.minOrderValue >= 0))
        err('mix.trigger', 'The minimum order value cannot be negative.');
      if (t.minQuantity != null && !isCount(t.minQuantity))
        err('mix.trigger', 'The minimum units must be a whole number above zero.');
      if (t.minOrderValue == null && t.minQuantity == null)
        warnings.push({
          path: 'mix.trigger',
          message: 'There is no trigger, so every order that matches gets the gift.',
        });
      break;
    }
    default:
      err('mix.type', 'Choose the kind of deal.');
  }
  return { errors, warnings };
}
