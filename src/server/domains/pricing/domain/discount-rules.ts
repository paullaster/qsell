import type {
  DiscountConditions,
  DiscountKind,
  DiscountLimits,
  DiscountReward,
  DiscountSchedule,
  DiscountTarget,
  Stacking,
} from './discounts';
import { NO_REWARD } from './discounts';
import { checkMix, type MixConfig } from './mix';
import { validateScopes, type RuleIssue } from './rules';
import type { Scopes } from './types';

/** What a person fills in to define a rule (the stored shape, minus identity and lifecycle). */
export interface DiscountRuleInput {
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
  /** The deal, for a `mix` or `gift` rule. */
  mix?: MixConfig | null;
}

export const LINE_REWARDS = ['percent', 'amount_per_unit', 'amount_per_line', 'set_price'] as const;
export const ORDER_REWARDS = ['percent', 'amount'] as const;
/** Most single products one rule may name; a larger set belongs in a product group. */
export const MAX_TARGET_PRODUCTS = 200;

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

export interface RuleChecks {
  /** Things that make the rule unusable. */
  errors: RuleIssue[];
  /** Things worth a second look, that do not stop it going live. */
  warnings: RuleIssue[];
}

/** Checks a rule's settings on their own, before anything in the database is consulted. */
export function checkDiscountRule(r: DiscountRuleInput): RuleChecks {
  const errors: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  const warn = (path: string, message: string) => warnings.push({ path, message });

  if (!r.name?.trim()) err('name', 'Give the rule a name.');
  if (!Number.isInteger(r.priority)) err('priority', 'The priority must be a whole number.');

  const priceRule = r.kind === 'line' || r.kind === 'order';
  if (!priceRule) {
    // A mix or gift rule is described by its deal, not by a reward.
    if (!r.mix) err('mix', 'Describe the deal.');
    else {
      const m = checkMix(r.mix);
      errors.push(...m.errors);
      warnings.push(...m.warnings);
      if ((r.kind === 'gift') !== (r.mix.type === 'gift'))
        err(
          'mix.type',
          r.kind === 'gift'
            ? 'A gift rule needs a gift deal.'
            : 'Choose a buy-and-get, mix-and-match or bundle deal.',
        );
    }
  }
  // Reward
  if (priceRule) {
    const allowed: readonly string[] = r.kind === 'line' ? LINE_REWARDS : ORDER_REWARDS;
    const t = r.reward?.type;
    if (!t || !allowed.includes(t))
      err(
        'reward.type',
        r.kind === 'line'
          ? 'Choose what the line discount gives.'
          : 'Choose what the order discount gives.',
      );
    const valueOk = (v: number, type: string) =>
      Number.isFinite(v) &&
      (type === 'percent' ? v > 0 && v <= 100 : type === 'set_price' ? v >= 0 : v > 0);
    if (t && allowed.includes(t)) {
      if (!valueOk(r.reward.value, t))
        err(
          'reward.value',
          t === 'percent'
            ? 'A percentage must be more than 0 and at most 100.'
            : t === 'set_price'
              ? 'The set price must be zero or more.'
              : 'The amount must be more than zero.',
        );
      const tiers = [...(r.reward.tiers ?? [])];
      tiers.forEach((tier, i) => {
        if (!(Number.isFinite(tier.from) && tier.from > 0))
          err(`reward.tiers.${i}`, `Step ${i + 1}: "from" must be more than zero.`);
        if (!valueOk(tier.value, t))
          err(`reward.tiers.${i}`, `Step ${i + 1}: the value is not valid.`);
      });
      const froms = tiers.map((x) => x.from);
      if (new Set(froms).size !== froms.length)
        err('reward.tiers', 'Two steps start at the same point.');
    }
    if (r.stacking === 'stackable' && t === 'set_price')
      err('stacking', 'A set price cannot be combined with other rules. Make it exclusive.');

    // Conditions: each only makes sense for one kind.
    const c = r.conditions ?? {};
    if (c.minQuantity != null) {
      if (r.kind !== 'line')
        err('conditions.minQuantity', 'A minimum quantity belongs to a line rule.');
      else if (!(c.minQuantity > 0))
        err('conditions.minQuantity', 'The minimum quantity must be more than zero.');
    }
    if (c.minOrderValue != null) {
      if (r.kind !== 'order')
        err('conditions.minOrderValue', 'A minimum order value belongs to an order rule.');
      else if (!(c.minOrderValue >= 0))
        err('conditions.minOrderValue', 'The minimum order value cannot be negative.');
    }
  }

  // Validity and schedule
  if (!(r.validFrom instanceof Date) || Number.isNaN(r.validFrom.getTime()))
    err('validFrom', 'Choose when the rule starts.');
  else if (r.validTo && r.validTo <= r.validFrom)
    err('validTo', 'The end must be after the start.');
  const s = r.schedule ?? {};
  if (s.days) {
    if (s.days.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
      err('schedule.days', 'Days of the week are 0 (Sunday) to 6 (Saturday).');
    if (new Set(s.days).size !== s.days.length) err('schedule.days', 'A day is listed twice.');
  }
  if (Boolean(s.from) !== Boolean(s.to))
    err('schedule', 'Give both a start and an end time, or neither.');
  else if (s.from && s.to) {
    if (!HHMM.test(s.from) || !HHMM.test(s.to)) err('schedule', 'Times are written like 16:00.');
    else if (s.from === s.to) err('schedule', 'The start and end time are the same.');
  }

  // Limits
  const l = r.limits ?? {};
  for (const k of ['maxUses', 'maxUsesPerCustomer'] as const)
    if (l[k] != null && !(Number.isInteger(l[k]) && l[k]! > 0))
      err(`limits.${k}`, 'A limit on uses must be a whole number above zero.');
  if (l.budget != null && !(l.budget > 0))
    err('limits.budget', 'The budget must be more than zero.');
  if (l.maxDiscountPercent != null && !(l.maxDiscountPercent > 0 && l.maxDiscountPercent <= 100))
    err('limits.maxDiscountPercent', 'The cap must be more than 0 and at most 100%.');

  // Target
  const tg = r.target ?? {};
  if ((tg.productIds?.length ?? 0) > MAX_TARGET_PRODUCTS)
    err(
      'target.productIds',
      `A rule can name at most ${MAX_TARGET_PRODUCTS} products. Put more in a product group and name the group.`,
    );

  errors.push(...validateScopes(r.scopes ?? {}));

  // Worth a second look
  if (!r.validTo) warn('validTo', 'It has no end date, so it runs until someone stops it.');
  if (priceRule) {
    const t = r.reward?.type;
    const c = r.conditions ?? {};
    if (t === 'percent' && r.reward.value >= 50 && r.reward.value <= 100)
      warn('reward.value', `${r.reward.value}% off is a deep discount. Check it is meant.`);
    if (r.kind === 'order' && c.minOrderValue == null && !r.requiresCoupon)
      warn(
        'conditions',
        'It has no minimum order value and needs no coupon, so it applies to every order.',
      );
    if (t && t !== 'percent' && l.budget == null && l.maxUses == null)
      warn(
        'limits',
        'A fixed amount with no budget or use limit has no ceiling on what it can give away.',
      );
  }
  return { errors, warnings };
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const fmt = (n: number) => n.toLocaleString('en-KE', { maximumFractionDigits: 2 });

/**
 * One plain sentence for what a rule does, for the screen and for an approver:
 * "10% off Brand Acme, for Wholesale A, from 1 Nov to 30 Nov, on weekends, at most 500 uses."
 * `names` turns the ids in the target and scope into words.
 */
export function summariseDiscount(
  r: DiscountRuleInput,
  names: Partial<
    Record<
      'category' | 'group' | 'product' | 'customer' | 'customer_group' | 'branch',
      Record<string, string>
    >
  > = {},
): string {
  const v = (n: number) => fmt(n);
  const reward = r.reward ?? NO_REWARD;
  const what =
    reward.type === 'percent'
      ? `${v(reward.value)}% off`
      : reward.type === 'amount_per_unit'
        ? `${v(reward.value)} off each unit`
        : reward.type === 'set_price'
          ? `price set to ${v(reward.value)}`
          : `${v(reward.value)} off`;
  const tiers =
    (reward.tiers?.length ?? 0) > 0
      ? ' (more at higher ' + (r.kind === 'line' ? 'quantities' : 'order values') + ')'
      : '';

  const pick = (ids: string[] | undefined, kind: 'category' | 'group' | 'product') =>
    (ids ?? []).map((id) => names[kind]?.[id] ?? id);
  /** "categories Shoes; brands Acme", or null when the target is everything. */
  const targetWords = (tg: DiscountTarget | undefined): string | null => {
    if (!tg || tg.all) return null;
    const parts: string[] = [];
    const cats = pick(tg.categoryIds, 'category');
    const groups = pick(tg.productGroupIds, 'group');
    const prods = pick(tg.productIds, 'product');
    const brands = tg.brands ?? [];
    if (cats.length) parts.push(`categories ${cats.join(', ')}`);
    if (brands.length) parts.push(`brands ${brands.join(', ')}`);
    if (groups.length) parts.push(`product groups ${groups.join(', ')}`);
    if (prods.length)
      parts.push(prods.length > 3 ? `${prods.length} named products` : prods.join(', '));
    return parts.length ? parts.join('; ') : null;
  };
  const words = targetWords(r.target);
  const where = !words
    ? r.kind === 'line'
      ? 'on every product'
      : 'on the whole order'
    : `on ${words}`;
  const of = (t: DiscountTarget | undefined) => {
    const w = targetWords(t);
    return w ? ` of ${w}` : '';
  };

  /** What a mix or gift deal does, in a phrase. */
  const deal = (): string => {
    const m = r.mix;
    if (!m) return 'A deal that has not been described yet';
    if (m.type === 'buy_get') {
      const g = m.get.reward;
      const reward =
        g.kind === 'free'
          ? 'free'
          : g.kind === 'percent'
            ? `${v(g.value ?? 0)}% off`
            : `at ${v(g.value ?? 0)} each`;
      return m.sameSet
        ? `Buy ${m.buy.quantity}${of(m.buy.target)}, get ${m.get.quantity} more ${reward} (the cheapest of each group)`
        : `Buy ${m.buy.quantity}${of(m.buy.target)}, get ${m.get.quantity}${of(m.get.target)} ${reward}`;
    }
    if (m.type === 'mix_match')
      return m.reward.kind === 'price'
        ? `Any ${m.quantity}${of(m.set)} for ${v(m.reward.value)}`
        : `${v(m.reward.value)}% off any ${m.quantity}${of(m.set)}`;
    if (m.type === 'bundle_deal')
      return `Bundle deal: ${m.slots.map((s) => `${s.quantity}${of(s.target) || ' of anything'}`).join(' + ')} for ${v(m.price)}`;
    const t = m.trigger;
    const gifts = m.gifts
      .map((g) => `${names.product?.[g.productId] ?? g.productId} x${g.quantity}`)
      .join(', ');
    const when = [
      t.minOrderValue != null ? `${v(t.minOrderValue)} or more of goods` : '',
      t.minQuantity != null ? `${t.minQuantity} or more units` : '',
    ].filter(Boolean);
    return `Free gift: ${gifts}${when.length ? ` when the order has ${when.join(' and ')}${of(t.target)}` : ''}`;
  };

  const when: string[] = [];
  const day = (d: Date) =>
    d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
  when.push(
    r.validTo
      ? `from ${day(r.validFrom)} to ${day(r.validTo)}`
      : `from ${day(r.validFrom)}, no end date`,
  );
  if (r.schedule.days?.length)
    when.push(
      `on ${[...r.schedule.days]
        .sort()
        .map((d) => DAY_NAMES[d])
        .join(', ')}`,
    );
  if (r.schedule.from && r.schedule.to)
    when.push(`between ${r.schedule.from} and ${r.schedule.to}`);

  const who: string[] = [];
  const scopeNames = (dim: 'customer' | 'customer_group' | 'branch') =>
    (r.scopes[dim]?.values ?? []).map((id) => names[dim]?.[id] ?? id);
  for (const [dim, label] of [
    ['customer', 'customer'],
    ['customer_group', 'customer group'],
    ['branch', 'branch'],
  ] as const) {
    const rule = r.scopes[dim];
    if (rule && rule.values.length > 0)
      who.push(`${rule.op === 'in' ? '' : 'not '}${label} ${scopeNames(dim).join(', ')}`);
  }
  for (const dim of ['sales_type', 'channel'] as const) {
    const rule = r.scopes[dim];
    if (rule && rule.values.length > 0)
      who.push(
        `${rule.op === 'in' ? '' : 'not '}${dim.replace('_', ' ')} ${rule.values.join(', ')}`,
      );
  }

  const need: string[] = [];
  if (r.conditions.minQuantity != null)
    need.push(`when buying ${v(r.conditions.minQuantity)} or more`);
  if (r.conditions.minOrderValue != null)
    need.push(`when the order comes to ${v(r.conditions.minOrderValue)} or more`);
  if (r.conditions.paymentMethods?.length)
    need.push(`paid by ${r.conditions.paymentMethods.join(' or ')}`);
  if (r.requiresCoupon) need.push('with a coupon code');

  const limits: string[] = [];
  if (r.limits.maxUses != null) limits.push(`at most ${fmt(r.limits.maxUses)} uses`);
  if (r.limits.maxUsesPerCustomer != null)
    limits.push(`${fmt(r.limits.maxUsesPerCustomer)} per customer`);
  if (r.limits.budget != null) limits.push(`up to ${fmt(r.limits.budget)} given away`);
  if (r.limits.maxDiscountPercent != null)
    limits.push(`never more than ${fmt(r.limits.maxDiscountPercent)}% of a line`);

  const isDeal = r.kind === 'mix' || r.kind === 'gift';
  const stack = isDeal
    ? r.kind === 'mix'
      ? 'Each unit earns at most one deal.'
      : ''
    : r.stacking === 'exclusive'
      ? 'Applies alone.'
      : 'Can combine with other stackable rules.';
  const sentence = [
    isDeal ? deal() : `${what}${tiers} ${where}`,
    need.length ? need.join(', ') : '',
    who.length ? `for ${who.join('; ')}` : '',
    when.join(', '),
    limits.length ? limits.join(', ') : '',
  ]
    .filter(Boolean)
    .join(', ');
  return `${sentence.charAt(0).toUpperCase()}${sentence.slice(1)}.${stack ? ` ${stack}` : ''}`;
}
