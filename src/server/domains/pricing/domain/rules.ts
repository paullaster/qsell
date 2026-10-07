import {
  CHANNELS,
  SALES_TYPES,
  SCOPE_DIMENSIONS,
  SCOPE_LABELS,
  type PriceListHeader,
  type Scopes,
  type SpecificityWeights,
  type Tier,
} from './types';
import { specificityOf } from './resolve';

export interface RuleIssue {
  path: string;
  message: string;
}

/** Checks the shape of scopes. Whether the ids exist is the service's job. */
export function validateScopes(scopes: Scopes): RuleIssue[] {
  const issues: RuleIssue[] = [];
  for (const key of Object.keys(scopes)) {
    if (!(SCOPE_DIMENSIONS as readonly string[]).includes(key)) {
      issues.push({
        path: `scopes.${key}`,
        message: `"${key}" is not something a price list can be limited by.`,
      });
    }
  }
  for (const d of SCOPE_DIMENSIONS) {
    const rule = scopes[d];
    if (!rule) continue;
    const at = `scopes.${d}`;
    if (rule.op !== 'in' && rule.op !== 'not_in')
      issues.push({
        path: at,
        message: `Choose whether ${SCOPE_LABELS[d].toLowerCase()} is "only" or "all except".`,
      });
    if (!Array.isArray(rule.values) || rule.values.length === 0)
      issues.push({
        path: at,
        message: `Pick at least one ${SCOPE_LABELS[d].toLowerCase()}, or remove the limit.`,
      });
    else if (
      d === 'sales_type' &&
      rule.values.some((v) => !(SALES_TYPES as readonly string[]).includes(v))
    )
      issues.push({ path: at, message: `Sales type must be ${SALES_TYPES.join(' or ')}.` });
    else if (
      d === 'channel' &&
      rule.values.some((v) => !(CHANNELS as readonly string[]).includes(v))
    )
      issues.push({ path: at, message: 'Unknown channel.' });
    else if (d === 'country' && rule.values.some((v) => !/^[A-Za-z]{2}$/.test(v)))
      issues.push({ path: at, message: 'Countries are two-letter codes, e.g. KE.' });
  }
  return issues;
}

/** Quantity breaks must start above zero, rise, and carry a price. */
export function validateTiers(tiers: Tier[], basePrice: number): RuleIssue[] {
  const issues: RuleIssue[] = [];
  let last = 0;
  tiers.forEach((t, i) => {
    const at = `tiers[${i}]`;
    if (!(t.fromQty > 0)) issues.push({ path: at, message: 'A quantity break starts above zero.' });
    else if (t.fromQty <= last)
      issues.push({ path: at, message: 'Quantity breaks must start higher than the one before.' });
    if (!(t.price >= 0) || !Number.isFinite(t.price))
      issues.push({ path: at, message: 'A quantity break needs a price.' });
    last = Math.max(last, t.fromQty);
  });
  if (!(basePrice >= 0) || !Number.isFinite(basePrice))
    issues.push({ path: 'price', message: 'Enter a price of zero or more.' });
  return issues;
}

type Overlap = Pick<
  PriceListHeader,
  'scopes' | 'validFrom' | 'validTo' | 'currency' | 'kind' | 'priority'
>;

/**
 * Could one sale fall inside both lists at once? Two lists cannot co-match when some dimension
 * is limited by `in` on both sides to values that share nothing.
 */
export function scopesCanOverlap(a: Scopes, b: Scopes): boolean {
  for (const d of SCOPE_DIMENSIONS) {
    const x = a[d];
    const y = b[d];
    if (x?.op === 'in' && y?.op === 'in' && !x.values.some((v) => y.values.includes(v)))
      return false;
  }
  return true;
}

const datesOverlap = (a: Overlap, b: Overlap) =>
  a.validFrom.getTime() < (b.validTo?.getTime() ?? Infinity) &&
  b.validFrom.getTime() < (a.validTo?.getTime() ?? Infinity);

/**
 * Two lists "tie" when a sale could match both, in the same currency, with equal specificity and
 * priority: the engine would have to fall back on dates and ids to choose between them. That is
 * deterministic but almost never what the business meant, so activation is stopped for it when
 * the two also price a product in common (checked by the service).
 */
export function wouldTie(a: Overlap, b: Overlap, weights: SpecificityWeights): boolean {
  return (
    a.currency === b.currency &&
    a.priority === b.priority &&
    specificityOf(a as PriceListHeader, weights) === specificityOf(b as PriceListHeader, weights) &&
    scopesCanOverlap(a.scopes, b.scopes) &&
    datesOverlap(a, b)
  );
}

/** One plain sentence describing who a list is for, for lists and the simulator. */
export function describeScopes(
  scopes: Scopes,
  names: Partial<Record<string, Record<string, string>>> = {},
): string {
  const parts: string[] = [];
  for (const d of SCOPE_DIMENSIONS) {
    const rule = scopes[d];
    if (!rule || rule.values.length === 0) continue;
    const shown = rule.values.map((v) => names[d]?.[v] ?? v).join(', ');
    parts.push(`${rule.op === 'in' ? '' : 'not '}${SCOPE_LABELS[d].toLowerCase()}: ${shown}`);
  }
  return parts.length ? parts.join(' · ') : 'Everyone, everywhere';
}
