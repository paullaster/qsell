import type { DiscountReward } from './discounts';

/**
 * What a discount would have cost if it had been in force over a past period. It is an estimate
 * from real sales: it assumes customers would have bought the same, so it shows the price of the
 * offer, not what the offer would do to demand.
 */
export interface SalesSlice {
  /** Units sold, net sales (tax left out), and the lines they were on. */
  units: number;
  lines: number;
  net: number;
  /** Cost of the units whose cost was known, and the net sales of those units. */
  cost: number;
  costedNet: number;
}

export interface Impact {
  matched: SalesSlice;
  /** What the rule would have given away over the period. */
  giveaway: number;
  /** Giveaway as a share of the matched net sales. */
  giveawayPercent: number;
  /** Margin on the matched sales before and after, on the part whose cost is known. Null if unknown. */
  marginBeforePercent: number | null;
  marginAfterPercent: number | null;
  /** The share of matched sales whose cost is known (0..100). */
  costCoveragePercent: number;
  /** Plain-language caveats worth showing next to the number. */
  notes: string[];
}

const r2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const r1 = (n: number) => Math.round((n + Number.EPSILON) * 10) / 10;

/** The largest percentage the reward can give, counting its quantity or value steps. */
export const largestPercent = (reward: DiscountReward): number =>
  reward.type === 'percent'
    ? Math.max(reward.value, ...(reward.tiers ?? []).map((t) => t.value))
    : 0;

/**
 * The cost of a line or order rule over a period. `slice` is the sales the rule's target covers;
 * for an order rule it is the orders that reach its minimum.
 */
export function estimateImpact(
  reward: DiscountReward,
  slice: SalesSlice,
  opts: { orders?: number; kind?: 'line' | 'order' } = {},
): Impact {
  const notes: string[] = [];
  let giveaway = 0;
  switch (reward.type) {
    case 'percent': {
      giveaway = (slice.net * reward.value) / 100;
      if ((reward.tiers?.length ?? 0) > 0)
        notes.push('Steps are not applied: the estimate uses the base percentage for every sale.');
      break;
    }
    case 'amount_per_unit':
      giveaway = slice.units * reward.value;
      notes.push('A fixed amount is in the product’s own tax basis; tax is not taken out.');
      break;
    case 'amount_per_line':
      giveaway = slice.lines * reward.value;
      break;
    case 'amount':
      giveaway = (opts.orders ?? 0) * reward.value;
      break;
    case 'set_price': {
      const unitNet = slice.units > 0 ? slice.net / slice.units : 0;
      giveaway = Math.max(0, unitNet - reward.value) * slice.units;
      notes.push('A set price is compared with the average price sold at, tax left out.');
      break;
    }
  }
  giveaway = Math.min(giveaway, slice.net);
  const coverage = slice.net > 0 ? (slice.costedNet / slice.net) * 100 : 0;
  // Margin is judged only on sales whose cost is known; the giveaway is spread in proportion.
  const share = slice.net > 0 ? slice.costedNet / slice.net : 0;
  const costedGive = giveaway * share;
  const before =
    slice.costedNet > 0 ? ((slice.costedNet - slice.cost) / slice.costedNet) * 100 : null;
  const after =
    slice.costedNet > 0
      ? ((slice.costedNet - costedGive - slice.cost) / (slice.costedNet - costedGive)) * 100
      : null;
  if (coverage < 100 && slice.net > 0)
    notes.push(
      `The cost is known for ${r1(coverage)}% of these sales; margin is worked out on those.`,
    );
  if (slice.net === 0)
    notes.push('Nothing in this period matched, so there is nothing to estimate from.');
  return {
    matched: slice,
    giveaway: r2(giveaway),
    giveawayPercent: slice.net > 0 ? r1((giveaway / slice.net) * 100) : 0,
    marginBeforePercent: before == null ? null : r1(before),
    marginAfterPercent: after == null ? null : r1(after),
    costCoveragePercent: r1(coverage),
    notes,
  };
}

/** Whole-period figures at a glance. */
export const marginPercent = (net: number, cost: number): number | null =>
  net > 0 ? r1(((net - cost) / net) * 100) : null;
