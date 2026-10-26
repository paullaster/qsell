/** Rules for landed costs: a charge (freight, duty, insurance) spread over received goods and added to what they cost. Pure. */

export const LANDED_KINDS = [
  { id: 'freight', label: 'Freight' },
  { id: 'duty', label: 'Import duty' },
  { id: 'insurance', label: 'Insurance' },
  { id: 'handling', label: 'Clearing and handling' },
  { id: 'other', label: 'Another charge' },
] as const;

export const LANDED_STATUS: Record<'draft' | 'posted' | 'cancelled', { label: string; tone: 'gray' | 'green' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  posted: { label: 'Posted', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export interface LandedCostForm {
  kind: string;
  description: string;
  reference: string;
  amount: string;
  method: 'value' | 'quantity';
}

export function checkLandedCost(f: LandedCostForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (!LANDED_KINDS.some((k) => k.id === f.kind)) p.kind = 'Choose what kind of charge it is.';
  if (f.description.trim().length < 2 || f.description.trim().length > 200) p.description = 'Describe the charge in 2 to 200 characters.';
  if (f.reference.trim().length < 1 || f.reference.trim().length > 80) p.reference = 'Give the number of the invoice or document the charge came on.';
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(f.amount.trim()) || Number(f.amount) <= 0) p.amount = 'The charge is an amount above zero, like 12500 or 830.50.';
  return p;
}

/**
 * Spreads `totalCents` over the weights in proportion, in whole cents that add up to the total exactly: each share is rounded down
 * and the cents left over go, one each, to the shares with the largest remainders (the earlier line first on a tie).
 */
export function spread(totalCents: number, weights: readonly number[]): number[] {
  const sum = weights.reduce((s, w) => s + w, 0);
  if (weights.length === 0 || sum <= 0 || totalCents < 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * w) / sum);
  const floors = exact.map((x) => Math.floor(x + 1e-9));
  let left = totalCents - floors.reduce((s, f) => s + f, 0);
  const order = exact.map((x, i) => ({ i, rem: x - (floors[i] ?? 0) })).sort((a, b) => (b.rem === a.rem ? a.i - b.i : b.rem - a.rem));
  const out = [...floors];
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = (out[i] ?? 0) + 1;
    left -= 1;
  }
  return out;
}

/** The new cost of one unit once its share is added, kept to the cent like every product cost. */
export const costAfter = (costCents: number, shareCents: number, units: number): number => costCents + Math.round(shareCents / units);
