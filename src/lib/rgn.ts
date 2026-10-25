/** Rules for received goods notes (design doc §10). Pure: shared by the form and the server. */

export const RGN_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  posted: { label: 'Posted', tone: 'green' },
  reversed: { label: 'Reversed', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export const REJECT_REASONS = [
  { id: 'damaged', label: 'Damaged' },
  { id: 'wrong_item', label: 'Not what was ordered' },
  { id: 'poor_quality', label: 'Poor quality' },
  { id: 'expired', label: 'Expired or too near expiry' },
  { id: 'short_shelf_life', label: 'Not to specification' },
  { id: 'other', label: 'Another reason' },
] as const;

export interface RgnHeaderForm {
  receivedDate: string;
  deliveryNoteNo: string;
  vehicle: string;
  notes: string;
}

export interface RgnLineForm {
  poLineId: string;
  delivered: string;
  rejected: string;
  rejectReason: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const QTY = /^\d{1,11}(\.\d{1,3})?$/;

export function checkRgnHeader(h: RgnHeaderForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (!DATE.test(h.receivedDate)) p.receivedDate = 'Use the date the goods arrived, like 2026-12-31.';
  if (h.deliveryNoteNo.trim().length < 1 || h.deliveryNoteNo.trim().length > 60) p.deliveryNoteNo = 'Write the number printed on the vendor’s delivery note.';
  return p;
}

/** A line may be left at zero delivered (nothing came of it); otherwise delivered is above zero and rejected is part of it. */
export function checkRgnLine(l: RgnLineForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (!QTY.test(l.delivered.trim())) p.delivered = 'Give the quantity that arrived, like 12 or 2.5.';
  const rejected = l.rejected.trim() === '' ? '0' : l.rejected.trim();
  if (!QTY.test(rejected)) p.rejected = 'Give the quantity you refused, or leave it empty.';
  if (p.delivered === undefined && p.rejected === undefined) {
    if (Number(rejected) > Number(l.delivered)) p.rejected = 'You cannot refuse more than arrived.';
    else if (Number(rejected) > 0 && !REJECT_REASONS.some((r) => r.id === l.rejectReason)) p.rejectReason = 'Say why the goods were refused.';
  }
  return p;
}

export const acceptedOf = (l: Pick<RgnLineForm, 'delivered' | 'rejected'>): number => Math.round((Number(l.delivered) - Number(l.rejected === '' ? '0' : l.rejected)) * 1000) / 1000;

/** The most that may be accepted on a line: what is still to come, plus the tolerance. Three decimals. */
export function mostAcceptable(ordered: number, received: number, cancelled: number, tolerancePercent: number): number {
  const ceiling = (ordered - cancelled) * (1 + tolerancePercent / 100);
  return Math.max(0, Math.floor((ceiling - received) * 1000 + 1e-6) / 1000);
}

/** Where an order stands after receiving: every line complete, some received, or none. */
export function receiptStatus(lines: readonly { quantity: number; received: number; cancelled: number }[]): 'received' | 'partially_received' | 'none' {
  if (lines.every((l) => l.received + 1e-9 >= l.quantity - l.cancelled)) return 'received';
  return lines.some((l) => l.received > 0) ? 'partially_received' : 'none';
}

/** Does the unit written on an order line match the unit the product is counted in? */
export const sameUnit = (orderUnit: string, product: { code: string; name: string; symbol: string | null }): boolean => {
  const u = orderUnit.trim().toLowerCase();
  return [product.code, product.name, product.symbol ?? ''].some((x) => x.trim().toLowerCase() === u && x.trim() !== '');
};
