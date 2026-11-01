/**
 * Which branch processes an order that is to be delivered. Pure: the distances and what each branch holds come in as parameters,
 * so the same facts always give the same branch and the reason can be written down with the order.
 *
 * The rule (docs/architecture/delivery-module.md §19): of the branches that can cover the whole order, the nearest to the customer.
 * When none can, the branch that covers the most of it (most lines, then most units), and of those the nearest. A branch that does
 * not offer the delivery method, or has no map pin when the customer's position is known, is not a candidate. Ties go to the
 * branch code, so the answer never depends on the order the branches were read in.
 */

export interface BranchOption {
  branchId: string;
  code: string;
  name: string;
  /** Road distance from the branch to the customer; null when it could not be measured (no pin on the branch). */
  km: number | null;
  minutes: number | null;
  /** Lines of the order this branch can supply in full, out of `totalLines`; and the units, out of `totalUnits`. */
  coversLines: number;
  totalLines: number;
  coversUnits: number;
  totalUnits: number;
  offersMethod: boolean;
}

export type ExcludedWhy = 'method_not_offered' | 'no_pin' | 'holds_none_of_it';

export type ChoiceReason =
  /** Only one branch could be considered. */
  | 'only_candidate'
  /** The nearest branch has all of it. */
  | 'nearest_covers_all'
  /** A nearer branch could not cover the whole order; this is the nearest that can. */
  | 'nearer_lacked_stock'
  /** No branch can cover it all; this one covers the most. */
  | 'best_cover'
  /** The customer's position is not known, so the branch is chosen by what it holds (then its code). */
  | 'position_unknown';

export interface BranchChoiceResult {
  chosen: BranchOption | null;
  reason: ChoiceReason | 'no_branch';
  /** The branches that were candidates, best first. */
  ranked: BranchOption[];
  excluded: { branchId: string; code: string; why: ExcludedWhy }[];
  /** Codes of nearer branches passed over because they could not cover the whole order. */
  passedOver: string[];
  /** True when the best branch does not hold every line, so the rest is split by the stock sourcing rules. */
  partial: boolean;
}

const coversAll = (b: BranchOption): boolean => b.coversLines >= b.totalLines && b.coversUnits >= b.totalUnits;
const distanceOf = (b: BranchOption): number => b.km ?? Number.POSITIVE_INFINITY;
const byCode = (a: { code: string }, b: { code: string }): number => a.code.localeCompare(b.code, 'en');

function byPreference(positioned: boolean) {
  return (a: BranchOption, b: BranchOption): number => {
    const full = Number(coversAll(b)) - Number(coversAll(a));
    if (full !== 0) return full;
    if (!coversAll(a)) {
      if (a.coversLines !== b.coversLines) return b.coversLines - a.coversLines;
      if (a.coversUnits !== b.coversUnits) return b.coversUnits - a.coversUnits;
    }
    if (positioned && distanceOf(a) !== distanceOf(b)) return distanceOf(a) - distanceOf(b);
    return byCode(a, b);
  };
}

/** `positioned` is whether the customer's position is known (a pin, or a written address the map could place). */
export function chooseBranch(options: readonly BranchOption[], positioned: boolean): BranchChoiceResult {
  const excluded: BranchChoiceResult['excluded'] = [];
  const candidates: BranchOption[] = [];
  for (const o of options) {
    if (!o.offersMethod) excluded.push({ branchId: o.branchId, code: o.code, why: 'method_not_offered' });
    else if (positioned && o.km === null) excluded.push({ branchId: o.branchId, code: o.code, why: 'no_pin' });
    else if (o.totalLines > 0 && o.coversUnits <= 0) excluded.push({ branchId: o.branchId, code: o.code, why: 'holds_none_of_it' });
    else candidates.push(o);
  }
  excluded.sort(byCode);
  const ranked = [...candidates].sort(byPreference(positioned));
  const chosen = ranked.at(0) ?? null;
  if (chosen === null) return { chosen: null, reason: 'no_branch', ranked, excluded, passedOver: [], partial: false };

  const partial = !coversAll(chosen);
  const nearer = (o: BranchOption): boolean => distanceOf(o) < distanceOf(chosen);
  const passedOver = positioned ? [...candidates].filter((o) => nearer(o) && !coversAll(o) && !partial).sort(byCode).map((o) => o.code) : [];
  let reason: ChoiceReason;
  if (!positioned) reason = 'position_unknown';
  else if (candidates.length === 1) reason = 'only_candidate';
  else if (partial) reason = 'best_cover';
  else reason = passedOver.length > 0 ? 'nearer_lacked_stock' : 'nearest_covers_all';
  return { chosen, reason, ranked, excluded, passedOver, partial };
}

/** The reason in the words shown beside the order. */
export function choiceWords(result: BranchChoiceResult): string {
  const c = result.chosen;
  if (c === null) return 'No branch can deliver this order.';
  const away = c.km === null ? '' : ` (${String(c.km)} km away)`;
  switch (result.reason) {
    case 'only_candidate':
      return `${c.name}${away} is the only branch that could deliver it.`;
    case 'nearest_covers_all':
      return `${c.name} is the nearest branch${away} and has all of it.`;
    case 'nearer_lacked_stock':
      return `${c.name}${away} is the nearest branch that has all of it; ${result.passedOver.join(', ')} ${result.passedOver.length === 1 ? 'is' : 'are'} nearer but cannot cover the whole order.`;
    case 'best_cover':
      return `No branch has all of it. ${c.name}${away} holds the most (${String(c.coversLines)} of ${String(c.totalLines)} lines); the rest comes from other locations.`;
    case 'position_unknown':
      return `${c.name} holds the most of it. The customer's position is not known, so distance was not used.`;
    case 'no_branch':
      return 'No branch can deliver this order.';
  }
}
