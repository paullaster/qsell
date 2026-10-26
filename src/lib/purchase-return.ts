/** Rules for goods sent back to a vendor after they were received (design doc §12.3). Pure: shared by the form and the server. */
import { isDay } from './vendor-insights';

export const RETURN_STATUS: Record<'draft' | 'posted' | 'cancelled', { label: string; tone: 'gray' | 'green' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  posted: { label: 'Posted', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export const RETURN_REASONS = [
  { id: 'faulty', label: 'Found faulty after receiving' },
  { id: 'wrong_item', label: 'Not what was ordered' },
  { id: 'over_supplied', label: 'More than was ordered' },
  { id: 'poor_quality', label: 'Poor quality' },
  { id: 'recall', label: 'Recalled by the vendor' },
  { id: 'other', label: 'Another reason' },
] as const;

export interface ReturnHeaderForm {
  returnDate: string;
  reason: string;
  vendorReference: string;
  notes: string;
}

export interface ReturnLineForm {
  rgnLineId: string;
  quantity: string;
}

const QTY = /^\d{1,11}(\.\d{1,3})?$/;

export function checkReturnHeader(h: ReturnHeaderForm, today: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (!isDay(h.returnDate)) p.returnDate = 'Use the date the goods were sent back, like 2026-12-31.';
  else if (h.returnDate > today) p.returnDate = 'The date cannot be in the future.';
  if (!RETURN_REASONS.some((r) => r.id === h.reason)) p.reason = 'Say why the goods are going back.';
  if (h.vendorReference.length > 80) p.vendorReference = 'Keep the vendor’s reference to 80 characters.';
  if (h.notes.length > 500) p.notes = 'Keep the notes to 500 characters.';
  return p;
}

export const quantityOk = (text: string): boolean => QTY.test(text.trim()) && Number(text) > 0;

/**
 * Checks the lines against what can go back: accepted, less what was invoiced (a credit memo opens invoiced goods again first)
 * and less what has already been returned. Quantities have three decimals.
 */
export function checkReturnLines(lines: ReturnLineForm[], room: ReadonlyMap<string, number>): { problems: Record<number, string>; any: boolean } {
  const problems: Record<number, string> = {};
  const seen = new Set<string>();
  lines.forEach((l, i) => {
    if (seen.has(l.rgnLineId)) problems[i] = 'This line is on the return twice.';
    seen.add(l.rgnLineId);
    if (problems[i] !== undefined) return;
    if (!room.has(l.rgnLineId)) problems[i] = 'That line is not on the note.';
    else if (!quantityOk(l.quantity)) problems[i] = 'Give the quantity going back, like 3 or 2.5.';
    else if (Math.round(Number(l.quantity) * 1000) > Math.round((room.get(l.rgnLineId) ?? 0) * 1000)) problems[i] = `Only ${String(room.get(l.rgnLineId))} can still go back.`;
  });
  return { problems, any: lines.length > 0 };
}

/** What can still go back on a note line, three decimals, never below zero. */
export const returnable = (accepted: number, invoiced: number, returned: number): number => Math.max(0, Math.round((accepted - invoiced - returned) * 1000) / 1000);
