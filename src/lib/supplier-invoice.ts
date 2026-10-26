import { has } from '@/lib/values';
import { lineAmounts } from '@/lib/purchase-order';

export type InvoiceState =
  | 'draft'
  | 'submitted'
  | 'received'
  | 'rgn_linked'
  | 'matched'
  | 'pending_approval'
  | 'approved'
  | 'posted'
  | 'returned'
  | 'rejected'
  | 'closed';

type Tone = 'green' | 'amber' | 'red' | 'sky' | 'gray';

export const INVOICE_STATE: Record<InvoiceState, { label: string; tone: Tone; vendorWords: string }> = {
  draft: { label: 'Draft', tone: 'gray', vendorWords: 'You are still preparing this invoice.' },
  submitted: { label: 'Submitted', tone: 'sky', vendorWords: 'Sent to us. Nobody has opened it yet, so you can still take it back.' },
  received: { label: 'Received', tone: 'sky', vendorWords: 'We have picked it up and are checking it.' },
  rgn_linked: { label: 'Goods linked', tone: 'sky', vendorWords: 'We have linked it to what we received from you.' },
  matched: { label: 'Checked', tone: 'sky', vendorWords: 'Checked against the order and what we received.' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber', vendorWords: 'Waiting for approval before we book it.' },
  approved: { label: 'Approved', tone: 'green', vendorWords: 'Approved. It will be booked for payment.' },
  posted: { label: 'Booked', tone: 'green', vendorWords: 'Booked for payment.' },
  returned: { label: 'Returned to you', tone: 'amber', vendorWords: 'We sent it back. Correct what we asked for and send it again.' },
  rejected: { label: 'Refused', tone: 'red', vendorWords: 'We cannot accept this invoice.' },
  closed: { label: 'Closed', tone: 'gray', vendorWords: 'You closed this invoice.' },
};

/** The vendor may change an invoice only while it is theirs. */
export const VENDOR_EDITABLE: readonly InvoiceState[] = ['draft', 'returned'];
/** Staff may send an invoice back at any point before it is booked. */
export const STAFF_RETURNABLE: readonly InvoiceState[] = ['received', 'rgn_linked', 'matched', 'pending_approval', 'approved'];
/** The states in which an invoice is in the staff queue (picked up or not). */
export const IN_QUEUE: readonly InvoiceState[] = ['submitted', 'received', 'rgn_linked', 'matched', 'pending_approval', 'approved'];

/** Reasons staff give when they return or refuse an invoice. Fixed list so reports can group them. */
export const INVOICE_REASONS = [
  { code: 'wrong_price', label: 'Prices differ from the order' },
  { code: 'wrong_quantity', label: 'Quantities differ from what we received' },
  { code: 'missing_delivery_note', label: 'A delivery note is missing or unreadable' },
  { code: 'wrong_tax', label: 'Tax is not right' },
  { code: 'unclear_invoice', label: 'The invoice copy is unclear' },
  { code: 'duplicate', label: 'We already have this invoice' },
  { code: 'not_ours', label: 'This invoice is not for us' },
  { code: 'no_delivery', label: 'We did not receive these goods' },
  { code: 'other', label: 'Something else (say what)' },
] as const;

export const reasonLabel = (code: string): string => INVOICE_REASONS.find((r) => r.code === code)?.label ?? code;

export interface InvoiceHeaderForm {
  vendorInvoiceNo: string;
  invoiceDate: string;
  dueDate: string;
  notes: string;
  declaration: boolean;
  /** The eTIMS invoice number printed on the vendor's invoice, and the link or code that verifies it. */
  etimsInvoiceNo?: string;
  etimsVerificationUrl?: string;
}

export const emptyInvoiceHeader = (today: string): InvoiceHeaderForm => ({ vendorInvoiceNo: '', invoiceDate: today, dueDate: '', notes: '', declaration: false });

export interface InvoiceLineForm {
  poLineId: string;
  quantity: string;
  unitPrice: string;
}

export interface DeliveryNoteForm {
  noteNo: string;
  noteDate: string;
  fileId: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s: string): boolean => DATE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().startsWith(s);
const positive = (s: string): boolean => /^\d+(\.\d{1,3})?$/.test(s.trim()) && Number(s) > 0;
const money = (s: string): boolean => /^\d+(\.\d{1,2})?$/.test(s.trim()) && Number(s) >= 0;

/** What a person types in the number is kept apart from spaces and case, so "INV 001" and "inv001" are the same invoice. */
export const normaliseInvoiceNo = (s: string): string => s.replace(/\s+/g, '').toLowerCase();

export function checkInvoiceHeader(h: InvoiceHeaderForm, today: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (h.vendorInvoiceNo.trim() === '') p.vendorInvoiceNo = 'Enter the number printed on your invoice.';
  else if (h.vendorInvoiceNo.trim().length > 40) p.vendorInvoiceNo = 'The invoice number is too long (40 characters at most).';
  if (!validDate(h.invoiceDate)) p.invoiceDate = 'Enter the date on your invoice.';
  else if (h.invoiceDate > today) p.invoiceDate = 'The invoice date cannot be in the future.';
  if (h.dueDate !== '') {
    if (!validDate(h.dueDate)) p.dueDate = 'Enter a valid date.';
    else if (validDate(h.invoiceDate) && h.dueDate < h.invoiceDate) p.dueDate = 'The due date cannot be before the invoice date.';
  }
  if (h.notes.length > 1000) p.notes = 'Notes are too long (1000 characters at most).';
  Object.assign(p, checkEtims(h));
  return p;
}

export function checkInvoiceLine(l: InvoiceLineForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (!has(l.poLineId)) p.poLineId = 'Choose the order line.';
  if (!positive(l.quantity)) p.quantity = 'Enter a quantity above zero (up to 3 decimals).';
  if (!money(l.unitPrice)) p.unitPrice = 'Enter the price per unit (up to 2 decimals).';
  return p;
}

export function checkDeliveryNote(n: DeliveryNoteForm, today: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (n.noteNo.trim() === '') p.noteNo = 'Enter the delivery note number.';
  else if (n.noteNo.trim().length > 40) p.noteNo = 'The delivery note number is too long (40 characters at most).';
  if (!validDate(n.noteDate)) p.noteDate = 'Enter the date on the delivery note.';
  else if (n.noteDate > today) p.noteDate = 'The delivery note date cannot be in the future.';
  if (!has(n.fileId)) p.fileId = 'Attach the signed copy of the delivery note.';
  return p;
}

/** Totals in cents from the lines as the server holds them: the browser shows the same sums as a preview only. */
export function invoiceTotals(lines: readonly { quantity: string; unitPrice: string; taxRate: string }[]): { subtotal: number; tax: number; total: number } {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const a = lineAmounts({ quantity: l.quantity, unitPrice: l.unitPrice, discountPercent: '0', taxRate: l.taxRate });
    subtotal += a.net;
    tax += a.tax;
  }
  return { subtotal, tax, total: subtotal + tax };
}

/**
 * Does the invoice need a delivery note? Yes, unless every order it is for is set up for an advance and has an advance payment
 * that is approved or paid (design doc §11.5). Returns the plain reason when it is not allowed.
 */
export function deliveryNoteRule(input: { deliveryNotes: number; orders: readonly { number: string; flagged: boolean; cover: boolean }[] }): { ok: boolean; advance: boolean; reason: string } {
  if (input.deliveryNotes > 0) return { ok: true, advance: false, reason: '' };
  const unflagged = input.orders.find((o) => !o.flagged);
  if (unflagged !== undefined) return { ok: false, advance: false, reason: `Add the delivery note for the goods. Order ${unflagged.number} is not set up for advance payment, so an invoice without a delivery note cannot be accepted.` };
  const uncovered = input.orders.find((o) => !o.cover);
  if (uncovered !== undefined) return { ok: false, advance: false, reason: `Add the delivery note for the goods. No advance payment has been approved yet for order ${uncovered.number}.` };
  return { ok: true, advance: input.orders.length > 0, reason: '' };
}

export interface Tolerances {
  /** More than the linked quantity, as a percent of it. */
  quantityPercent: number;
  /** More than the order's price, as a percent of it. */
  pricePercent: number;
  /** Or, as a line, no more than this amount in cents. Either one passes. */
  priceAmountCents: number;
}

export const DEFAULT_TOLERANCES: Tolerances = { quantityPercent: 0, pricePercent: 2, priceAmountCents: 10_000 };

export interface MatchInput {
  invoiceQuantity: number;
  invoiceUnitPriceCents: number;
  invoiceTaxRate: number;
  /** Total of the received-goods quantities linked to this line. */
  linkedQuantity: number;
  /** The order line's price after its discount, in cents per unit. */
  orderUnitPriceCents: number;
  orderTaxRate: number;
  /** A line for services or other things with no stock needs an expense account to be booked to. */
  needsAccount: boolean;
  hasAccount: boolean;
}

export interface MatchResult {
  status: 'ok' | 'exception';
  problems: string[];
  /** Invoice minus order, whole line, in cents. Positive means the vendor charges more. */
  priceDifferenceCents: number;
  quantityDifference: number;
}

const roundQty = (n: number): number => Math.round(n * 1000) / 1000;

/** How far above the order's price the invoice is, in percent; any price above a free item is an infinite rise. */
function risePercent(orderCents: number, invoiceCents: number): number {
  if (orderCents === 0) return invoiceCents > 0 ? Infinity : 0;
  return ((invoiceCents - orderCents) / orderCents) * 100;
}

/** One invoice line against the order and what we received (design doc §11.6). */
export function matchLine(m: MatchInput, t: Tolerances): MatchResult {
  const problems: string[] = [];
  const quantityDifference = roundQty(m.invoiceQuantity - m.linkedQuantity);
  const allowedExtra = roundQty((m.linkedQuantity * t.quantityPercent) / 100);
  if (m.linkedQuantity <= 0) problems.push('No received goods are linked to this line.');
  else if (quantityDifference > allowedExtra) problems.push(`The invoice charges for ${String(m.invoiceQuantity)} but only ${String(m.linkedQuantity)} are linked.`);
  const priceDifferenceCents = Math.round((m.invoiceUnitPriceCents - m.orderUnitPriceCents) * m.invoiceQuantity);
  const percent = risePercent(m.orderUnitPriceCents, m.invoiceUnitPriceCents);
  if (priceDifferenceCents > 0 && percent > t.pricePercent && priceDifferenceCents > t.priceAmountCents) {
    problems.push(`The price is above the order by ${(priceDifferenceCents / 100).toFixed(2)} on this line.`);
  }
  if (m.invoiceTaxRate !== m.orderTaxRate) problems.push(`The tax rate is ${String(m.invoiceTaxRate)}% but the order says ${String(m.orderTaxRate)}%.`);
  if (m.needsAccount && !m.hasAccount) problems.push('Choose the account this line is booked to.');
  return { status: problems.length === 0 ? 'ok' : 'exception', problems, priceDifferenceCents, quantityDifference };
}

export interface LinkCandidate {
  rgnLineId: string;
  /** Accepted minus what earlier invoices already claim, minus what other invoices in progress have linked. */
  room: number;
}

/** Suggests links for a line from the oldest received goods first. `shortfall` is what could not be covered. */
export function suggestLinks(quantity: number, candidates: readonly LinkCandidate[]): { links: { rgnLineId: string; quantity: number }[]; shortfall: number } {
  const links: { rgnLineId: string; quantity: number }[] = [];
  let left = roundQty(quantity);
  for (const c of candidates) {
    if (left <= 0) break;
    const take = Math.min(left, roundQty(c.room));
    if (take > 0) {
      links.push({ rgnLineId: c.rgnLineId, quantity: roundQty(take) });
      left = roundQty(left - take);
    }
  }
  return { links, shortfall: Math.max(0, left) };
}

/** The person who linked or checked an invoice cannot approve it (design doc §21). Returns the plain reason, or null. */
export function approvalSeparation(approver: string, linkedBy: string | null, matchedBy: string | null): string | null {
  if (approver === linkedBy || approver === matchedBy) return 'You linked or checked this invoice, so another person has to approve it.';
  return null;
}

/** An invoice can be taken back only while nobody on our side has touched it. */
export const canRecall = (state: InvoiceState, firstActionAt: string | null): boolean => state === 'submitted' && firstActionAt === null;

export interface PostingLine {
  kind: 'stock' | 'account';
  accountId: string | null;
  netCents: number;
}

export interface PostingPlan {
  debits: { key: string; accountId: string | null; purpose: 'inventory_clearing' | 'account'; cents: number }[];
  taxCents: number;
  payableCents: number;
}

/** Where an invoice's money goes: stock to the "received, not invoiced" account, everything else to the account chosen, tax to input tax, the whole to the vendor. */
export function postingPlan(lines: readonly PostingLine[], taxCents: number): PostingPlan {
  const byKey = new Map<string, PostingPlan['debits'][number]>();
  for (const l of lines) {
    if (l.netCents === 0) continue;
    const key = l.kind === 'stock' ? 'stock' : `account:${l.accountId ?? 'none'}`;
    const existing = byKey.get(key);
    if (existing === undefined) byKey.set(key, { key, accountId: l.kind === 'stock' ? null : l.accountId, purpose: l.kind === 'stock' ? 'inventory_clearing' : 'account', cents: l.netCents });
    else existing.cents += l.netCents;
  }
  const debits = [...byKey.values()];
  const net = debits.reduce((s, d) => s + d.cents, 0);
  return { debits, taxCents, payableCents: net + taxCents };
}

const ETIMS_NO = /^[A-Za-z0-9][A-Za-z0-9\-/ ]{3,39}$/;

function isSecureLink(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:' && url.length <= 300;
  } catch {
    return false;
  }
}

/** What is wrong with the eTIMS details on an invoice, if anything: both are optional here; the company's rule says when they are needed. */
export function checkEtims(h: Pick<InvoiceHeaderForm, 'etimsInvoiceNo' | 'etimsVerificationUrl'>): Record<string, string> {
  const p: Record<string, string> = {};
  const no = (h.etimsInvoiceNo ?? '').trim();
  const url = (h.etimsVerificationUrl ?? '').trim();
  if (no !== '' && !ETIMS_NO.test(no)) p.etimsInvoiceNo = 'Enter the eTIMS invoice number printed on the invoice (4 to 40 letters, digits, dashes or slashes).';
  if (url !== '' && !isSecureLink(url)) p.etimsVerificationUrl = 'The verification link must be a web address starting with https:// (300 characters at most).';
  return p;
}

/** Whether the invoice may be sent as far as eTIMS goes: with tax on it and the company's rule on, it needs the eTIMS invoice number. */
export function etimsRefusal(taxCents: number, ruleOn: boolean, h: Pick<InvoiceHeaderForm, 'etimsInvoiceNo'>): string | null {
  if (!ruleOn || taxCents <= 0) return null;
  return (h.etimsInvoiceNo ?? '').trim() === '' ? 'An invoice with tax needs its eTIMS invoice number, so the input tax can be claimed. Enter the number printed on your invoice.' : null;
}
