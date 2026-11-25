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

// ── A load once it is made (docs/architecture/van-sales.md §6.2, §6.3) ────────────────────────────────────────────

export const LOAD_KINDS = ['load', 'top_up'] as const;
export type LoadKind = (typeof LOAD_KINDS)[number];
export const LOAD_KIND_WORDS: Record<LoadKind, string> = { load: 'Load', top_up: 'Top-up' };

/** The steps of the stock transfer a load is made of, in the words a load shows. */
export const LOAD_STATE_WORDS: Record<string, string> = {
  draft: 'Being made',
  requested: 'Asked for',
  approved: 'Approved',
  shipped: 'On its way to the van',
  partly_received: 'Partly signed for',
  received: 'Signed for',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

export interface LoadSteps {
  /** A second person agrees (only where the company wants a transfer approved). */
  approve: boolean;
  /** The stock leaves the warehouse. */
  ship: boolean;
  /** The rep signs for what arrived on the van. */
  sign: boolean;
  /** Called off before anything left the warehouse. */
  cancel: boolean;
}

/** What can be done to a load now, from where its transfer has got to. */
export function loadSteps(load: { state: string; signed: boolean; cancelled: boolean; needsApproval: boolean }): LoadSteps {
  if (load.cancelled) return { approve: false, ship: false, sign: false, cancel: false };
  return {
    approve: load.state === 'requested' && load.needsApproval,
    ship: load.state === 'approved' || (load.state === 'requested' && !load.needsApproval),
    sign: !load.signed && (load.state === 'shipped' || load.state === 'partly_received'),
    cancel: load.state === 'draft' || load.state === 'requested' || load.state === 'approved',
  };
}

export interface SignInput {
  /** What the rep counted onto the van, by product; empty means everything that was sent. */
  entries: { productId: string; quantity: number }[] | null;
  /** Why the office signs for the rep, when it does. */
  reason: string | null;
}

export type SignRead = { ok: true; sign: SignInput } | { ok: false; error: string };

/** Reads a signing: everything that was sent, or the quantities the rep counted (each product once, none less than nothing). */
export function readSign(raw: unknown): SignRead {
  const r = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {};
  const reason = typeof r.reason === 'string' && r.reason.trim() !== '' ? r.reason.trim() : null;
  if (r.entries === undefined || r.entries === null) return { ok: true, sign: { entries: null, reason } };
  if (!Array.isArray(r.entries) || r.entries.length > 500) return { ok: false, error: 'What arrived could not be read.' };
  const seen = new Set<string>();
  const entries: { productId: string; quantity: number }[] = [];
  for (const e of r.entries as unknown[]) {
    const x = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {};
    if (typeof x.productId !== 'string' || x.productId === '') return { ok: false, error: 'Choose each product from the load.' };
    if (seen.has(x.productId)) return { ok: false, error: 'A product can be counted once. Add its quantities together.' };
    seen.add(x.productId);
    const q = typeof x.quantity === 'number' ? x.quantity : Number(x.quantity);
    if (!Number.isFinite(q) || q < 0) return { ok: false, error: 'A quantity cannot be less than nothing.' };
    entries.push({ productId: x.productId, quantity: roundQty(q) });
  }
  return { ok: true, sign: { entries, reason } };
}

// ── The planner's list on screen ──────────────────────────────────────────────────────────────────────────────

/** One line of the load being made up: what the warehouse and the route say, and the quantity the planner will load, as typed. */
export interface PlannerRow {
  productId: string;
  name: string;
  /** The route's usual quantity; null for a product the planner added by hand. */
  par: number | null;
  onVan: number | null;
  available: number | null;
  quantity: string;
  short: number;
  /** The planner typed this quantity (or added the product): a new suggestion never replaces it. */
  edited: boolean;
}

export interface SuggestedRow {
  productId: string;
  productName: string;
  par: number;
  onVan: number;
  available: number;
  loadable: number;
  short: number;
}

export const plannerRows = (rows: readonly SuggestedRow[]): PlannerRow[] =>
  rows.map((r) => ({ productId: r.productId, name: r.productName, par: r.par, onVan: r.onVan, available: r.available, quantity: String(r.loadable), short: r.short, edited: false }));

/**
 * A fresh suggestion (from another warehouse) brings what that warehouse holds and what is short, but never replaces what the planner has
 * already done: quantities they typed stay, products they added by hand stay, and products they took off stay off.
 */
export function mergeSuggestion(fresh: readonly PlannerRow[], previous: readonly PlannerRow[], removed: ReadonlySet<string>): PlannerRow[] {
  const before = new Map(previous.map((r) => [r.productId, r]));
  const suggested = fresh
    .filter((r) => !removed.has(r.productId))
    .map((r) => {
      const had = before.get(r.productId);
      return had?.edited === true ? { ...r, quantity: had.quantity, edited: true } : r;
    });
  const suggestedIds = new Set(fresh.map((r) => r.productId));
  return [...suggested, ...previous.filter((r) => r.par === null && !suggestedIds.has(r.productId))];
}
