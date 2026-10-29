/**
 * Which location supplies which line of an order. Pure: the candidates (already in the order of preference) and what each can
 * promise come in as parameters. Design: docs/architecture/stock-locations.md §6.2 and decision 9 of §17: one location unless none
 * can cover the whole order.
 */

export interface SourcingLine {
  productId: string;
  quantity: number;
}

export interface SourcingCandidate {
  locationId: string;
  code: string;
}

/** Available quantity by location, then product. A missing entry is none. */
export type AvailabilityGrid = ReadonlyMap<string, ReadonlyMap<string, number>>;

export interface Allocation {
  productId: string;
  locationId: string;
  quantity: number;
}

export interface SourcingTrace {
  rule: 'whole_order_at_one_location' | 'line_at_one_location' | 'line_split_across_locations';
  /** The location that covered the whole order, when one did. */
  locationCode?: string;
}

export type SourcingPlan =
  | { ok: true; allocations: Allocation[]; trace: Record<string, SourcingTrace> }
  | { ok: false; productId: string; available: number; requested: number };

const round = (n: number): number => Math.round(n * 1000) / 1000;
const availableAt = (grid: AvailabilityGrid, locationId: string, productId: string): number => grid.get(locationId)?.get(productId) ?? 0;

export function planSourcing(lines: readonly SourcingLine[], candidates: readonly SourcingCandidate[], grid: AvailabilityGrid): SourcingPlan {
  // A product named on several lines is planned once, for the total.
  const wanted = mergeLines(lines).filter((l) => l.quantity > 0);
  // 1. One location for everything, if there is one that can.
  for (const c of candidates) {
    if (wanted.every((l) => availableAt(grid, c.locationId, l.productId) >= l.quantity)) {
      return {
        ok: true,
        allocations: wanted.map((l) => ({ productId: l.productId, locationId: c.locationId, quantity: l.quantity })),
        trace: Object.fromEntries(wanted.map((l) => [l.productId, { rule: 'whole_order_at_one_location' as const, locationCode: c.code }])),
      };
    }
  }
  // 2. Each line from the first location that covers it; failing that, split it over several, in order of preference.
  const taken = new Map<string, number>();
  const key = (locationId: string, productId: string) => `${locationId}\u0000${productId}`;
  const allocations: Allocation[] = [];
  const trace: Record<string, SourcingTrace> = {};
  for (const l of wanted) {
    const free = (locationId: string) => round(availableAt(grid, locationId, l.productId) - (taken.get(key(locationId, l.productId)) ?? 0));
    const single = candidates.find((c) => free(c.locationId) >= l.quantity);
    if (single !== undefined) {
      allocations.push({ productId: l.productId, locationId: single.locationId, quantity: l.quantity });
      taken.set(key(single.locationId, l.productId), round((taken.get(key(single.locationId, l.productId)) ?? 0) + l.quantity));
      trace[l.productId] = { rule: 'line_at_one_location', locationCode: single.code };
      continue;
    }
    const total = round(candidates.reduce((sum, c) => sum + Math.max(0, free(c.locationId)), 0));
    if (total < l.quantity) return { ok: false, productId: l.productId, available: total, requested: l.quantity };
    let left = l.quantity;
    for (const c of candidates) {
      const part = Math.min(left, Math.max(0, free(c.locationId)));
      if (part <= 0) continue;
      allocations.push({ productId: l.productId, locationId: c.locationId, quantity: round(part) });
      taken.set(key(c.locationId, l.productId), round((taken.get(key(c.locationId, l.productId)) ?? 0) + part));
      left = round(left - part);
      if (left <= 0) break;
    }
    trace[l.productId] = { rule: 'line_split_across_locations' };
  }
  return { ok: true, allocations, trace };
}

/** The lines of an order added up by product, in a stable order, so the same product is never planned twice. */
export function mergeLines(lines: readonly SourcingLine[]): SourcingLine[] {
  const sums = new Map<string, number>();
  for (const l of lines) sums.set(l.productId, round((sums.get(l.productId) ?? 0) + l.quantity));
  return [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([productId, quantity]) => ({ productId, quantity }));
}
