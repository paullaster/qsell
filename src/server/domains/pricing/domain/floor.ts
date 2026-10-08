import type { FloorProduct, FloorResult, FloorRule } from './types';

const round = (n: number, dp = 4) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * The floor for one product: the most specific rule that applies, applied to its cost.
 *
 *   1. a rule on the product itself;
 *   2. a rule on a product group it is in, or on its brand (the strictest of these wins);
 *   3. a rule on its category, or on the nearest category above it;
 *   4. the company default.
 *
 * A rule with no cost to work from gives no floor, and says so, rather than a floor of nothing.
 */
export function resolveFloor(product: FloorProduct, rules: FloorRule[]): FloorResult {
  const rule = pickRule(product, rules);
  if (!rule) return { floorNet: null, rule: null, note: null, source: null };
  if (!(product.costPrice > 0))
    return {
      floorNet: null,
      rule,
      note: 'The product has no cost on file, so the floor cannot be worked out.',
      source: null,
    };
  return {
    floorNet: round(product.costPrice * (1 + rule.markupPercent / 100)),
    rule,
    note: null,
    source: null,
  };
}

function pickRule(product: FloorProduct, rules: FloorRule[]): FloorRule | null {
  const direct = rules.find((r) => r.scopeType === 'product' && r.scopeRef === product.id);
  if (direct) return direct;

  const groups = rules.filter(
    (r) =>
      (r.scopeType === 'product_group' && product.groupIds.includes(r.scopeRef)) ||
      (r.scopeType === 'brand' &&
        product.brand != null &&
        r.scopeRef.toLowerCase() === product.brand.trim().toLowerCase()),
  );
  if (groups.length > 0)
    // Several apply: the strictest holds, so a product is never sold below any group's floor.
    return groups.reduce((a, b) => (b.markupPercent > a.markupPercent ? b : a));

  for (const categoryId of product.categoryChain) {
    const hit = rules.find((r) => r.scopeType === 'category' && r.scopeRef === categoryId);
    if (hit) return hit;
  }
  return rules.find((r) => r.scopeType === 'default') ?? null;
}

/** How far below the floor a price is, as a percentage of the floor. Zero when at or above it. */
export function shortfallPercent(netUnit: number, floorNet: number): number {
  if (!(floorNet > 0) || netUnit >= floorNet) return 0;
  return round(((floorNet - netUnit) / floorNet) * 100, 2);
}

/** How far a price has been taken below the list price, as a percentage. Zero when not below. */
export function reductionPercent(netUnit: number, listNetUnit: number): number {
  if (!(listNetUnit > 0) || netUnit >= listNetUnit) return 0;
  return round(((listNetUnit - netUnit) / listNetUnit) * 100, 2);
}

/** A person's override limit from their roles: the most generous of their own, else the default. */
export function limitFor(
  roleKeys: string[],
  limits: Array<{ roleKey: string; maxPercent: number }>,
  superAdmin: boolean,
): number | null {
  if (superAdmin || limits.length === 0) return null;
  const own = limits.filter((l) => roleKeys.includes(l.roleKey));
  if (own.length > 0) return Math.max(...own.map((l) => l.maxPercent));
  const fallback = limits.find((l) => l.roleKey === '*');
  return fallback ? fallback.maxPercent : null;
}

/** Describes where a floor came from, for explanations: "Brand Acme: cost + 12%". */
export function describeRule(rule: FloorRule, names: Record<string, string> = {}): string {
  const what =
    rule.scopeType === 'default'
      ? 'The company default'
      : rule.scopeType === 'product'
        ? `This product's own rule`
        : rule.scopeType === 'product_group'
          ? `Product group ${names[rule.scopeRef] ?? rule.scopeRef}`
          : rule.scopeType === 'brand'
            ? `Brand ${rule.scopeRef}`
            : `Category ${names[rule.scopeRef] ?? rule.scopeRef}`;
  return `${what}: cost + ${rule.markupPercent}%`;
}
