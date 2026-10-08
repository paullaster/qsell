import type { RuleIssue } from './rules';

/**
 * Loyalty points: earned on what a customer spends, kept in a ledger, spent like money against a
 * later order. Points are a liability, so they are never a price change: a redemption is a tender.
 */
export interface LoyaltyTier {
  name: string;
  /** Lifetime points earned to reach the tier. */
  fromPoints: number;
  /** Earn rate is multiplied by this (1.5 = half as many again). */
  multiplier: number;
}

export interface LoyaltyConfig {
  /** Points earned for each 100 spent (before the tier multiplier). */
  pointsPer100: number;
  /** What one point is worth when spent. */
  pointValue: number;
  /** Fewest points that may be spent at once. */
  minRedeemPoints: number;
  /** The largest share of an order's payable amount points can cover. */
  maxRedeemPercent: number;
  /** Points not spent expire this many months after they were earned. Null: never. */
  expiryMonths: number | null;
  tiers: LoyaltyTier[];
}

export const MAX_LOYALTY_TIERS = 10;

export function tierFor(lifetimePoints: number, tiers: LoyaltyTier[]): LoyaltyTier | null {
  let hit: LoyaltyTier | null = null;
  for (const t of [...tiers].sort((a, b) => a.fromPoints - b.fromPoints))
    if (lifetimePoints >= t.fromPoints) hit = t;
  return hit;
}

/** Points a spend earns, always rounded down so the company never gives more than promised. */
export function pointsEarned(spend: number, c: LoyaltyConfig, lifetimePoints = 0): number {
  if (!(spend > 0)) return 0;
  const mult = tierFor(lifetimePoints, c.tiers)?.multiplier ?? 1;
  // The small epsilon stops 0.29 x 100 style float error from losing a point.
  return Math.floor((spend / 100) * c.pointsPer100 * mult + 1e-9);
}

export const pointsValue = (points: number, c: LoyaltyConfig): number =>
  Math.round((points * c.pointValue + Number.EPSILON) * 100) / 100;

/**
 * How many points, and what value, can be spent against `due`, given what the customer has and
 * the limits. `want` is how many they asked for (or all they can use when not given).
 */
export function redemption(
  due: number,
  balance: number,
  c: LoyaltyConfig,
  want?: number,
): { points: number; value: number; problem: string | null } {
  const none = (problem: string) => ({ points: 0, value: 0, problem });
  if (!(due > 0)) return none('Nothing is left to pay.');
  const ceiling = Math.floor((due * c.maxRedeemPercent) / 100 / c.pointValue + 1e-9);
  const asked = want ?? Number.MAX_SAFE_INTEGER;
  if (want != null && (!Number.isInteger(want) || want <= 0))
    return none('Enter a whole number of points.');
  if (want != null && want > balance) return none(`Only ${balance} points are available.`);
  const points = Math.min(asked, balance, ceiling);
  if (points <= 0) return none('No points can be used on this order.');
  if (points < c.minRedeemPoints)
    return none(`At least ${c.minRedeemPoints} points must be used at a time.`);
  return { points, value: pointsValue(points, c), problem: null };
}

export function checkLoyalty(c: LoyaltyConfig): { errors: RuleIssue[]; warnings: RuleIssue[] } {
  const errors: RuleIssue[] = [];
  const warnings: RuleIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  if (!(c.pointsPer100 > 0) || c.pointsPer100 > 1000)
    err('pointsPer100', 'Points per 100 spent must be above 0 and at most 1,000.');
  if (!(c.pointValue > 0) || c.pointValue > 1000)
    err('pointValue', 'A point must be worth more than 0.');
  if (!Number.isInteger(c.minRedeemPoints) || c.minRedeemPoints < 1)
    err('minRedeemPoints', 'The smallest redemption is at least 1 point.');
  if (!(c.maxRedeemPercent > 0) || c.maxRedeemPercent > 100)
    err('maxRedeemPercent', 'The share of an order points can cover is between 0 and 100%.');
  if (
    c.expiryMonths != null &&
    (!Number.isInteger(c.expiryMonths) || c.expiryMonths < 1 || c.expiryMonths > 120)
  )
    err('expiryMonths', 'Expiry is a whole number of months, up to 120, or empty for never.');
  if (c.tiers.length > MAX_LOYALTY_TIERS) err('tiers', `At most ${MAX_LOYALTY_TIERS} tiers.`);
  const seen = new Set<number>();
  c.tiers.forEach((t, i) => {
    if (!t.name.trim()) err(`tiers.${i}.name`, 'Name the tier.');
    if (!Number.isFinite(t.fromPoints) || t.fromPoints < 0)
      err(`tiers.${i}.fromPoints`, 'A tier starts at zero points or more.');
    if (seen.has(t.fromPoints)) err(`tiers.${i}.fromPoints`, 'Two tiers start at the same points.');
    seen.add(t.fromPoints);
    if (!(t.multiplier >= 1) || t.multiplier > 10)
      err(`tiers.${i}.multiplier`, 'A tier multiplier is between 1 and 10.');
  });
  const back = (c.pointsPer100 * c.pointValue) / 100;
  if (back > 0.1)
    warnings.push({
      path: 'pointValue',
      message: `Customers get back ${(back * 100).toFixed(1)}% of what they spend as points, before tier bonuses. Check this is intended.`,
    });
  return { errors, warnings };
}

export function summariseLoyalty(c: LoyaltyConfig): string {
  const back = ((c.pointsPer100 * c.pointValue) / 100) * 100;
  return `Customers earn ${c.pointsPer100} point(s) for every 100 spent (about ${back.toFixed(1)}% back). A point is worth ${c.pointValue} when spent, at least ${c.minRedeemPoints} at a time, covering up to ${c.maxRedeemPercent}% of an order. ${c.expiryMonths ? `Unspent points expire after ${c.expiryMonths} months.` : 'Points do not expire.'}${
    c.tiers.length
      ? ` Tiers: ${[...c.tiers]
          .sort((a, b) => a.fromPoints - b.fromPoints)
          .map((t) => `${t.name} from ${t.fromPoints} lifetime points earns ${t.multiplier}×`)
          .join(', ')}.`
      : ''
  }`;
}
