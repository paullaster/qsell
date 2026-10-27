import { quantityProblem } from '@/lib/unit-rules';

/**
 * The least and most of an item that may be bought at once. Both are empty by default: no limit. They are counted in the item's
 * own unit, and apply to everyone who buys it (the shop, staff orders, quotes), measured over the whole document, not line by line.
 */
export interface QuantityLimits {
  minQty: number | null;
  maxQty: number | null;
}

export interface LimitedItem {
  name: string;
  baseUnitName: string;
  baseUnitDecimals: number;
  minOrderQty?: number | null;
  maxOrderQty?: number | null;
}

const positive = (value: number | null | undefined): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

export const limitsOf = (item: Pick<LimitedItem, 'minOrderQty' | 'maxOrderQty'>): QuantityLimits => ({
  minQty: positive(item.minOrderQty),
  maxQty: positive(item.maxOrderQty),
});

export const hasLimits = (limits: QuantityLimits): boolean => limits.minQty !== null || limits.maxQty !== null;

const shown = (value: number, unitName: string): string => `${String(Number(value.toFixed(3)))} ${unitName}`;

/** Why a pair of limits cannot be saved on an item, in words; null when they can. Empty means no limit. */
export function limitsProblem(minQty: number | null, maxQty: number | null, decimals: number, unitName: string): string | null {
  for (const [value, what] of [[minQty, 'The minimum quantity'], [maxQty, 'The maximum quantity']] as const) {
    if (value === null) continue;
    if (!Number.isFinite(value) || value <= 0) return `${what} must be above zero. Leave it empty for no limit.`;
    const fit = quantityProblem(value, decimals, unitName, what);
    if (fit !== null) return fit;
  }
  if (minQty !== null && maxQty !== null && minQty > maxQty) {
    return `The minimum quantity (${shown(minQty, unitName)}) cannot be above the maximum (${shown(maxQty, unitName)}).`;
  }
  return null;
}

/** Why this quantity may not be bought of this item, in words for the buyer; null when it may. */
export function purchaseQuantityProblem(quantity: number, item: LimitedItem): string | null {
  const { minQty, maxQty } = limitsOf(item);
  if (minQty !== null && quantity < minQty) return `The least you can buy of "${item.name}" is ${shown(minQty, item.baseUnitName)}.`;
  if (maxQty !== null && quantity > maxQty) return `The most you can buy of "${item.name}" is ${shown(maxQty, item.baseUnitName)}.`;
  return null;
}

/** The nearest quantity that may be bought. */
export function clampToLimits(quantity: number, limits: QuantityLimits): number {
  let next = quantity;
  if (limits.minQty !== null && next < limits.minQty) next = limits.minQty;
  if (limits.maxQty !== null && next > limits.maxQty) next = limits.maxQty;
  return next;
}

/** The quantity a basket starts with when the item is first added: the minimum, else one. */
export const startingQuantity = (limits: QuantityLimits): number => clampToLimits(1, limits);

/** What a plus or minus button does: one step, but never below the minimum (it drops to nothing instead) or above the maximum. Returns 0 for "remove". */
export function stepQuantity(current: number, direction: 1 | -1, step: number, limits: QuantityLimits): number {
  const moved = Number((current + direction * step).toFixed(3));
  if (direction === -1) {
    if (moved <= 0) return 0;
    if (limits.minQty !== null && moved < limits.minQty) return 0;
    return moved;
  }
  return limits.maxQty !== null && moved > limits.maxQty ? limits.maxQty : moved;
}

/** The words shown beside a quantity box. Empty when there is no limit. */
export function limitsHint(limits: QuantityLimits, unitName: string): string {
  const number = (value: number): string => String(Number(value.toFixed(3)));
  if (limits.minQty !== null && limits.maxQty !== null) return `Buy ${number(limits.minQty)} to ${shown(limits.maxQty, unitName)} at a time.`;
  if (limits.minQty !== null) return `Minimum ${shown(limits.minQty, unitName)} per order.`;
  if (limits.maxQty !== null) return `Maximum ${shown(limits.maxQty, unitName)} per order.`;
  return '';
}

/**
 * Checks the quantities of a whole document against each item's limits. The same item on two lines counts once, with its
 * lines added together, so a limit cannot be got round by splitting a quantity over lines. One sentence per item that breaks a limit.
 */
export function basketQuantityProblems(lines: readonly { productId: string; quantity: number; item: LimitedItem }[]): string[] {
  const totals = new Map<string, { quantity: number; item: LimitedItem }>();
  for (const line of lines) {
    const seen = totals.get(line.productId);
    if (seen === undefined) totals.set(line.productId, { quantity: line.quantity, item: line.item });
    else seen.quantity = Number((seen.quantity + line.quantity).toFixed(3));
  }
  const problems: string[] = [];
  for (const { quantity, item } of totals.values()) {
    const problem = purchaseQuantityProblem(quantity, item);
    if (problem !== null) problems.push(problem);
  }
  return problems;
}
