import type { DiscountTarget } from './discounts';
import { validateScopes, type RuleIssue } from './rules';
import type { Scopes } from './types';
import { DEFAULT_BUSINESS_TIMEZONE, businessDate } from '@/server/kernel/numbering/business-date';

/**
 * Rebates: money given back after the fact, on what a customer bought over a period (2% back on
 * everything once a quarter's purchases pass 5,000,000). The sale itself is not discounted. Each
 * order adds what it is worth to the customer's running total for the period, and when the period
 * is over the total decides the rate.
 */
export const REBATE_PERIODS = ['month', 'quarter', 'year'] as const;
export type RebatePeriod = (typeof REBATE_PERIODS)[number];

/**
 *  - `all_sales`: the highest step reached gives its rate on every shilling bought (retroactive).
 *  - `incremental`: each step's rate applies only to what was bought above its threshold.
 */
export const TIER_MODES = ['all_sales', 'incremental'] as const;
export type TierMode = (typeof TIER_MODES)[number];

export interface RebateTier {
  /** Purchases of at least this, in the period, reach the step. */
  from: number;
  percent: number;
}

export interface RebateProgramInput {
  code: string;
  name: string;
  period: RebatePeriod;
  tierMode: TierMode;
  tiers: RebateTier[];
  scopes: Scopes;
  target: DiscountTarget;
  validFrom: Date;
  validTo: Date | null;
}

export const MAX_REBATE_TIERS = 20;
export const MAX_REBATE_PERCENT = 50;

const money = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** The period a moment falls in, by the company's calendar: `2026-10`, `2026-Q4`, `2026`. */
export function periodKey(
  at: Date,
  period: RebatePeriod,
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): string {
  const [y, m] = businessDate(at, timeZone).split('-');
  if (period === 'year') return y!;
  if (period === 'month') return `${y}-${m}`;
  return `${y}-Q${Math.floor((Number(m) - 1) / 3) + 1}`;
}

/** First and last day (inclusive, `YYYY-MM-DD`) of a period. */
export function periodRange(key: string): { start: string; end: string } {
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  const m = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(key);
  const y = /^(\d{4})$/.exec(key);
  const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();
  const pad = (n: number) => String(n).padStart(2, '0');
  if (q) {
    const year = Number(q[1]);
    const first = (Number(q[2]) - 1) * 3 + 1;
    const last = first + 2;
    return {
      start: `${year}-${pad(first)}-01`,
      end: `${year}-${pad(last)}-${lastDay(year, last)}`,
    };
  }
  if (m) {
    const year = Number(m[1]);
    const month = Number(m[2]);
    return {
      start: `${year}-${pad(month)}-01`,
      end: `${year}-${pad(month)}-${lastDay(year, month)}`,
    };
  }
  if (y) return { start: `${y[1]}-01-01`, end: `${y[1]}-12-31` };
  throw new Error(`Not a rebate period: ${key}`);
}

/** Has the period finished, so its total can no longer grow? */
export function periodEnded(key: string, now: Date = new Date()): boolean {
  return businessDate(now) > periodRange(key).end;
}

export function periodLabel(key: string): string {
  const q = /^(\d{4})-Q([1-4])$/.exec(key);
  if (q) return `Quarter ${q[2]} ${q[1]}`;
  const m = /^(\d{4})-(\d{2})$/.exec(key);
  if (m)
    return `${new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${m[1]}`;
  return key;
}

const sorted = (tiers: RebateTier[]) => [...tiers].sort((a, b) => a.from - b.from);

/** What a period's purchases earn back, to the cent. */
export function rebateFor(basis: number, tiers: RebateTier[], mode: TierMode): number {
  if (!(basis > 0) || tiers.length === 0) return 0;
  const t = sorted(tiers);
  if (mode === 'all_sales') {
    let hit: RebateTier | null = null;
    for (const tier of t) if (basis >= tier.from) hit = tier;
    return hit ? money((basis * hit.percent) / 100) : 0;
  }
  let total = 0;
  for (let i = 0; i < t.length; i++) {
    const low = t[i]!.from;
    const high = i + 1 < t.length ? t[i + 1]!.from : Infinity;
    if (basis <= low) break;
    total += ((Math.min(basis, high) - low) * t[i]!.percent) / 100;
  }
  return money(total);
}

/** The rate reached so far, for display. For incremental programs it is the blended rate. */
export function effectivePercent(basis: number, tiers: RebateTier[], mode: TierMode): number {
  if (!(basis > 0)) return 0;
  return Math.round((rebateFor(basis, tiers, mode) / basis) * 100 * 1000) / 1000;
}

/** How much more must be bought to reach the next step, or null at the top. */
export function toNextTier(
  basis: number,
  tiers: RebateTier[],
): { needed: number; percent: number } | null {
  const next = sorted(tiers).find((t) => t.from > basis);
  return next ? { needed: money(next.from - basis), percent: next.percent } : null;
}

export function checkRebateProgram(p: RebateProgramInput): {
  errors: RuleIssue[];
  warnings: RuleIssue[];
} {
  const errors: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  if (!p.name?.trim()) err('name', 'Give the programme a name.');
  if (!REBATE_PERIODS.includes(p.period)) err('period', 'Choose month, quarter or year.');
  if (!TIER_MODES.includes(p.tierMode)) err('tierMode', 'Choose how the steps work.');
  if (p.tiers.length === 0) err('tiers', 'Add at least one step, for example 2% from 5,000,000.');
  if (p.tiers.length > MAX_REBATE_TIERS) err('tiers', `At most ${MAX_REBATE_TIERS} steps.`);
  const seen = new Set<number>();
  p.tiers.forEach((t, i) => {
    if (!Number.isFinite(t.from) || t.from < 0)
      err(`tiers.${i}.from`, 'A step starts at zero or more.');
    if (seen.has(t.from)) err(`tiers.${i}.from`, 'Two steps start at the same amount.');
    seen.add(t.from);
    if (!(t.percent > 0) || t.percent > MAX_REBATE_PERCENT)
      err(`tiers.${i}.percent`, `A rate must be above 0 and at most ${MAX_REBATE_PERCENT}%.`);
  });
  const s = sorted(p.tiers);
  for (let i = 1; i < s.length; i++)
    if (s[i]!.percent <= s[i - 1]!.percent)
      warnings.push({
        path: 'tiers',
        message: 'A higher step usually gives a higher rate; check the order.',
      });
  if (p.validTo && p.validTo <= p.validFrom) err('validTo', 'It must end after it starts.');
  errors.push(...validateScopes(p.scopes));
  return { errors, warnings };
}

/** The programme in plain words, with the same wording on screen and in approval summaries. */
export function summariseRebate(
  p: RebateProgramInput,
  names: { category?: Record<string, string>; group?: Record<string, string> } = {},
): string {
  const fmt = (n: number) => n.toLocaleString('en-KE', { maximumFractionDigits: 2 });
  const steps = sorted(p.tiers).map((t) => `${fmt(t.percent)}% from ${fmt(t.from)}`);
  const t = p.target;
  const what =
    t.all === true ||
    (t.categoryIds?.length ?? 0) +
      (t.brands?.length ?? 0) +
      (t.productGroupIds?.length ?? 0) +
      (t.productIds?.length ?? 0) ===
      0
      ? 'all purchases'
      : [
          ...(t.categoryIds ?? []).map((c) => names.category?.[c] ?? 'a category'),
          ...(t.brands ?? []),
          ...(t.productGroupIds ?? []).map((g) => names.group?.[g] ?? 'a product group'),
          ...((t.productIds?.length ?? 0) > 0 ? [`${t.productIds!.length} named product(s)`] : []),
        ].join(', ');
  const how =
    p.tierMode === 'all_sales'
      ? 'the step reached applies to everything bought in the period'
      : 'each step applies only to what is bought above it';
  const per = { month: 'a month', quarter: 'a quarter', year: 'a year' }[p.period];
  const who = Object.entries(p.scopes).filter(([, r]) => r && r.values.length > 0);
  return `Gives back ${steps.join(', ') || 'nothing yet'} of ${what} bought in ${per} (${how}), settled by credit once the period has ended${who.length ? `, for ${who.map(([d, r]) => `${d.replace('_', ' ')}${r!.op === 'not_in' ? ' except' : ''}: ${r!.values.length} chosen`).join('; ')}` : ''}.`;
}
