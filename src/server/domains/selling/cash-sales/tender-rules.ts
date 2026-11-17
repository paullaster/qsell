/**
 * Paying a counter sale: what the buyer hands over in each way, and what the sale takes, in cents so nothing drifts. Pure: no clock, no
 * database. Only cash can be handed over in excess (change is given back in cash); M-Pesa and card pay exactly what they are for.
 */

export type TenderKind = 'cash' | 'mobile_money' | 'card';
export const TENDER_KINDS: readonly TenderKind[] = ['cash', 'mobile_money', 'card'];
export const MAX_TENDERS = 4;

export interface TenderRequest {
  methodId: string;
  /** The kind of the method, as the server found it (never what the browser says). */
  kind: TenderKind;
  /** Cash: what was handed over. Others: what was paid with it. */
  amount: number;
  /** The M-Pesa code or card slip number, where the method asks for one. */
  reference: string | null;
}

export interface PlannedTender {
  methodId: string;
  kind: TenderKind;
  /** What the sale took with this method (net of change). */
  applied: number;
  /** Cash only: what was handed over, and what goes back. */
  handedOver: number | null;
  changeDue: number | null;
  reference: string | null;
}

export type TenderPlan = { ok: true; tenders: PlannedTender[]; changeDue: number; total: number } | { ok: false; error: string };

const cents = (amount: number): number => Math.round(amount * 100);
const fromCents = (value: number): number => value / 100;
const isMoney = (amount: number): boolean => Number.isFinite(amount) && amount > 0 && Math.abs(amount * 100 - Math.round(amount * 100)) < 1e-6;

export function planTenders(total: number, requests: readonly TenderRequest[]): TenderPlan {
  const totalCents = cents(total);
  if (totalCents <= 0) return { ok: false, error: 'There is nothing to pay on this sale.' };
  if (requests.length === 0) return { ok: false, error: 'Choose how the customer pays.' };
  if (requests.length > MAX_TENDERS) return { ok: false, error: `A sale can be paid in at most ${String(MAX_TENDERS)} ways.` };
  const seen = new Set<string>();
  for (const r of requests) {
    if (!isMoney(r.amount)) return { ok: false, error: 'Give each amount as more than nothing, with at most two decimals.' };
    if (seen.has(r.methodId)) return { ok: false, error: 'Each way of paying can be used once on a sale: add the amounts together.' };
    seen.add(r.methodId);
  }
  if (requests.filter((r) => r.kind === 'cash').length > 1) return { ok: false, error: 'Cash can be given once on a sale: add the notes together.' };
  const exact = requests.filter((r) => r.kind !== 'cash').reduce((sum, r) => sum + cents(r.amount), 0);
  if (exact > totalCents) return { ok: false, error: 'M-Pesa and card cannot be more than the sale: they cannot give change.' };
  const cash = requests.find((r) => r.kind === 'cash');
  const dueInCash = totalCents - exact;
  if (cash === undefined) {
    if (dueInCash > 0) return { ok: false, error: `The sale is KES ${fromCents(totalCents).toFixed(2)} and ${fromCents(exact).toFixed(2)} was paid: ${fromCents(dueInCash).toFixed(2)} is still to pay.` };
  } else {
    if (dueInCash === 0) return { ok: false, error: 'The other ways of paying already cover the sale: take the cash off.' };
    if (cents(cash.amount) < dueInCash) return { ok: false, error: `The cash is short: ${fromCents(dueInCash - cents(cash.amount)).toFixed(2)} more is needed.` };
  }
  const changeDue = cash === undefined ? 0 : cents(cash.amount) - dueInCash;
  return {
    ok: true,
    total: fromCents(totalCents),
    changeDue: fromCents(changeDue),
    tenders: requests.map((r) =>
      r.kind === 'cash'
        ? { methodId: r.methodId, kind: r.kind, applied: fromCents(dueInCash), handedOver: r.amount, changeDue: fromCents(changeDue), reference: r.reference }
        : { methodId: r.methodId, kind: r.kind, applied: r.amount, handedOver: null, changeDue: null, reference: r.reference },
    ),
  };
}

/** What a sale's recorded tenders add to a shift's till: the cash the sale took (net of change). */
export const cashTaken = (tenders: readonly { kind: string; applied: number }[]): number => fromCents(tenders.filter((t) => t.kind === 'cash').reduce((sum, t) => sum + cents(t.applied), 0));
