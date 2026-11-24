/**
 * What to load on a van (docs/architecture/van-sales.md §6.2): the route's par level less what is already on the van, plus the pre-sold
 * orders to hand over that day. Pure; quantities are in each product's base unit.
 */
import { roundQty } from '@/lib/decimal';

export interface LoadInput {
  /** The quantity a route's van should start the day with, per product. */
  par: ReadonlyMap<string, number>;
  /** What is on the van now. */
  onVan: ReadonlyMap<string, number>;
  /** What the day's drops need, per product. */
  drops: ReadonlyMap<string, number>;
  /** What the warehouse can give, per product; omit to suggest without checking. */
  warehouse?: ReadonlyMap<string, number>;
}

export interface LoadRow {
  productId: string;
  par: number;
  onVan: number;
  drops: number;
  /** What the day needs put on. */
  wanted: number;
  /** What can be put on from the warehouse (all of it when the warehouse was not checked). */
  loadable: number;
  /** What the warehouse cannot give. */
  short: number;
}

const at = (m: ReadonlyMap<string, number>, id: string): number => Math.max(m.get(id) ?? 0, 0);

export function suggestLoad(input: LoadInput): LoadRow[] {
  const ids = new Set<string>([...input.par.keys(), ...input.drops.keys()]);
  const rows: LoadRow[] = [];
  for (const productId of ids) {
    const par = at(input.par, productId);
    const onVan = at(input.onVan, productId);
    const drops = at(input.drops, productId);
    const wanted = roundQty(Math.max(par - onVan, 0) + drops);
    if (wanted <= 0) continue;
    const loadable = input.warehouse === undefined ? wanted : roundQty(Math.min(wanted, at(input.warehouse, productId)));
    rows.push({ productId, par, onVan, drops, wanted, loadable, short: roundQty(wanted - loadable) });
  }
  return rows.sort((a, b) => a.productId.localeCompare(b.productId));
}

/** What to tell the planner about a row that cannot be fully loaded. */
export const shortWords = (row: Pick<LoadRow, 'wanted' | 'loadable' | 'short'>): string | null =>
  row.short > 0 ? `${String(row.short)} short: ${String(row.wanted)} wanted, ${String(row.loadable)} can be loaded.` : null;
