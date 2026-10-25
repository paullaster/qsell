import { has } from '@/lib/values';
import { lineAmounts } from '@/lib/purchase-order';
import { INVOICE_REASONS } from '@/lib/supplier-invoice';

export type CreditState = 'draft' | 'submitted' | 'received' | 'approved' | 'posted' | 'returned' | 'rejected' | 'closed';
type Tone = 'green' | 'amber' | 'red' | 'sky' | 'gray';

export const CREDIT_STATE: Record<CreditState, { label: string; tone: Tone; vendorWords: string }> = {
  draft: { label: 'Draft', tone: 'gray', vendorWords: 'You are still preparing this credit note.' },
  submitted: { label: 'Submitted', tone: 'sky', vendorWords: 'Sent to us. Nobody has opened it yet, so you can still take it back.' },
  received: { label: 'Being checked', tone: 'sky', vendorWords: 'We have picked it up and are checking it.' },
  approved: { label: 'Approved', tone: 'green', vendorWords: 'Approved. It will be taken off what we owe you.' },
  posted: { label: 'Booked', tone: 'green', vendorWords: 'Booked: what we owe you is reduced.' },
  returned: { label: 'Returned to you', tone: 'amber', vendorWords: 'We sent it back. Correct what we asked for and send it again.' },
  rejected: { label: 'Refused', tone: 'red', vendorWords: 'We cannot accept this credit note.' },
  closed: { label: 'Closed', tone: 'gray', vendorWords: 'You closed this credit note.' },
};

export const CREDIT_VENDOR_EDITABLE: readonly CreditState[] = ['draft', 'returned'];
export const CREDIT_STAFF_RETURNABLE: readonly CreditState[] = ['received', 'approved'];
export const CREDIT_IN_QUEUE: readonly CreditState[] = ['submitted', 'received', 'approved'];
/** States in which a credit memo holds a claim on part of the invoice (so two cannot credit the same thing twice). */
export const CREDIT_CLAIMING: readonly CreditState[] = ['submitted', 'received', 'approved', 'posted'];
export const CREDIT_REASONS = INVOICE_REASONS;

export interface CreditHeaderForm {
  vendorCreditNo: string;
  creditDate: string;
  reason: string;
  notes: string;
}

export interface CreditLineForm {
  invoiceLineId: string;
  mode: 'quantity' | 'price';
  quantity: string;
  unitPrice: string;
}

export interface OriginalLine {
  id: string;
  description: string;
  /** What was billed: quantity, price per unit, tax rate, net in cents. */
  quantity: number;
  unitPriceCents: number;
  taxRate: number;
  netCents: number;
  /** Already credited by other credit memos that are submitted, approved or booked. */
  creditedQuantity: number;
  creditedNetCents: number;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string): boolean => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function checkCreditHeader(h: CreditHeaderForm, today: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (h.vendorCreditNo.trim() === '') p.vendorCreditNo = 'Enter the number printed on your credit note.';
  else if (h.vendorCreditNo.trim().length > 40) p.vendorCreditNo = 'The number is too long (40 characters at most).';
  if (!validDate(h.creditDate)) p.creditDate = 'Enter the date on your credit note.';
  else if (h.creditDate > today) p.creditDate = 'The date cannot be in the future.';
  if (h.reason.trim() === '') p.reason = 'Say why you are crediting this invoice.';
  else if (h.reason.length > 500) p.reason = 'The reason is too long (500 characters at most).';
  if (h.notes.length > 1000) p.notes = 'Notes are too long (1000 characters at most).';
  return p;
}

export interface CreditAmounts {
  quantity: number;
  unitPrice: string;
  netCents: number;
  taxCents: number;
}

/** What one credit line is worth. A quantity credit is some of the goods at the price billed; a price credit is all of them, by so much a unit. */
export function creditAmounts(line: CreditLineForm, original: OriginalLine): CreditAmounts {
  const quantity = line.mode === 'quantity' ? Number(line.quantity) : original.quantity;
  const unitPrice = line.mode === 'quantity' ? (original.unitPriceCents / 100).toFixed(2) : Number(line.unitPrice).toFixed(2);
  const a = lineAmounts({ quantity: String(quantity), unitPrice, discountPercent: '0', taxRate: String(original.taxRate) });
  return { quantity, unitPrice, netCents: a.net, taxCents: a.tax };
}

export function checkCreditLine(line: CreditLineForm, original: OriginalLine | undefined): Record<string, string> {
  const p: Record<string, string> = {};
  if (original === undefined) return { invoiceLineId: 'That line is not on the invoice.' };
  if (line.mode === 'quantity') {
    if (!/^\d+(\.\d{1,3})?$/.test(line.quantity.trim()) || Number(line.quantity) <= 0) return { quantity: 'Enter the quantity to credit (up to 3 decimals).' };
    const room = round3(original.quantity - original.creditedQuantity);
    if (Number(line.quantity) > room) p.quantity = `Only ${String(Math.max(room, 0))} of this line can still be credited.`;
  } else if (!/^\d+(\.\d{1,2})?$/.test(line.unitPrice.trim()) || Number(line.unitPrice) <= 0) {
    return { unitPrice: 'Enter how much a unit was billed too high, above zero (up to 2 decimals).' };
  } else if (Math.round(Number(line.unitPrice) * 100) > original.unitPriceCents) {
    p.unitPrice = `That is more than the price billed (${(original.unitPriceCents / 100).toFixed(2)}).`;
  }
  if (Object.keys(p).length > 0) return p;
  const a = creditAmounts(line, original);
  if (a.netCents + original.creditedNetCents > original.netCents) p.invoiceLineId = `This would credit more than was billed on the line (${(original.netCents / 100).toFixed(2)}, ${(original.creditedNetCents / 100).toFixed(2)} already credited).`;
  return p;
}

export function creditTotals(amounts: readonly CreditAmounts[]): { subtotal: number; tax: number; total: number } {
  const subtotal = amounts.reduce((n, a) => n + a.netCents, 0);
  const tax = amounts.reduce((n, a) => n + a.taxCents, 0);
  return { subtotal, tax, total: subtotal + tax };
}

export interface GoodsLink {
  rgnLineId: string;
  /** How much of this received goods line the invoice line was linked to. */
  linked: number;
  /** How much of it is counted as invoiced now. */
  invoiced: number;
}

/** Takes a credited quantity back off the goods the line was linked to, the last link first, never more than is counted as invoiced. */
export function takeBackFromLinks(quantity: number, links: readonly GoodsLink[]): { takes: { rgnLineId: string; quantity: number }[]; short: number } {
  const takes: { rgnLineId: string; quantity: number }[] = [];
  let left = round3(quantity);
  for (const l of [...links].reverse()) {
    if (left <= 0) break;
    const take = Math.min(left, round3(Math.min(l.linked, l.invoiced)));
    if (take > 0) {
      takes.push({ rgnLineId: l.rgnLineId, quantity: round3(take) });
      left = round3(left - take);
    }
  }
  return { takes, short: Math.max(0, left) };
}

export const canRecallCredit = (state: CreditState, firstActionAt: string | null): boolean => state === 'submitted' && firstActionAt === null;
export const hasFile = (id: string | null): boolean => id !== null && has(id);
