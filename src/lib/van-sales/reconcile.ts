/**
 * Counting a van back in (docs/architecture/van-sales.md §5.3): what should be on it from the ledger, what was counted, the difference
 * and its worth at cost, and whether a second person must decide it. Pure.
 */
import { roundQty } from '@/lib/decimal';
import type { ShortageRule } from './settings';

export interface DayFlows {
  opening: number;
  loaded: number;
  sold: number;
  delivered: number;
  returnedGood: number;
  unloaded: number;
}

/** What should be on the van: what it started with and was loaded with, less what went out to customers and back to the warehouse. */
export const expectedOnVan = (f: DayFlows): number => roundQty(f.opening + f.loaded - f.sold - f.delivered + f.returnedGood - f.unloaded);

export interface Counted {
  productId: string;
  expected: number;
  counted: number;
  /** The cost of one in force at the time. */
  unitCost: number;
}
export interface VarianceRow extends Counted {
  /** Counted less expected: negative is a shortage. */
  difference: number;
  kind: 'short' | 'over' | 'none';
  /** The worth of the difference at cost, never negative. */
  value: number;
}

const money = (n: number): number => Math.round(n * 100) / 100;

const kindOf = (difference: number): VarianceRow['kind'] => {
  if (difference < 0) return 'short';
  return difference > 0 ? 'over' : 'none';
};

export function varianceOf(c: Counted): VarianceRow {
  const difference = roundQty(c.counted - c.expected);
  return { ...c, difference, kind: kindOf(difference), value: money(Math.abs(difference) * c.unitCost) };
}

export interface Decision {
  rows: VarianceRow[];
  shortValue: number;
  overValue: number;
  /** A shortage above the company's limit needs a second person. */
  needsApproval: boolean;
  /** Who bears the shortage, by the company's rule. */
  bearer: ShortageRule | null;
}

export function decide(counts: readonly Counted[], rule: { shortage: ShortageRule; shortageApprovalAbove: number }): Decision {
  const rows = counts.map(varianceOf).filter((r) => r.kind !== 'none');
  const shortValue = money(rows.filter((r) => r.kind === 'short').reduce((s, r) => s + r.value, 0));
  const overValue = money(rows.filter((r) => r.kind === 'over').reduce((s, r) => s + r.value, 0));
  return { rows, shortValue, overValue, needsApproval: shortValue > 0 && shortValue > rule.shortageApprovalAbove, bearer: shortValue > 0 ? rule.shortage : null };
}

/** What a day end screen says about the count. */
export const decisionWords = (d: Decision): string => {
  if (d.rows.length === 0) return 'The van is exactly as it should be.';
  const parts: string[] = [];
  if (d.shortValue > 0) parts.push(`short by KES ${d.shortValue.toFixed(2)}`);
  if (d.overValue > 0) parts.push(`over by KES ${d.overValue.toFixed(2)}`);
  return `The van is ${parts.join(' and ')} at cost.${d.needsApproval ? ' A second person must decide this.' : ''}`;
};
