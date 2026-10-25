/** Rules for requests for quotation, quotes, their totals and the comparison sheet (design doc §8). Pure: the clock is passed in. */

export const RFQ_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  issued: { label: 'Open for quotes', tone: 'green' },
  closed: { label: 'Closed, being compared', tone: 'sky' },
  awarded: { label: 'Awarded', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'red' },
};

export interface RfqHeaderForm {
  title: string;
  categoryId: string;
  description: string;
  terms: string;
  requiredBy: string;
  /** `YYYY-MM-DDTHH:mm`, local time of the buyer. */
  deadline: string;
  validityDays: string;
  currency: string;
  sealed: boolean;
  allowPartial: boolean;
  allowAlternatives: boolean;
  estimatedValue: string;
}

export const emptyRfqHeader = (): RfqHeaderForm => ({ title: '', categoryId: '', description: '', terms: '', requiredBy: '', deadline: '', validityDays: '30', currency: '', sealed: true, allowPartial: false, allowAlternatives: false, estimatedValue: '' });

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
const MONEY = /^\d{1,12}(\.\d{1,2})?$/;

export function checkRfqHeader(f: RfqHeaderForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (f.title.trim().length < 3 || f.title.trim().length > 200) p.title = 'Give the request a title of 3 to 200 characters.';
  if (f.categoryId.trim() === '') p.categoryId = 'Choose the category. Only vendors qualified in it can be invited.';
  if (!DATETIME.test(f.deadline)) p.deadline = 'Choose the date and time quotes are due.';
  if (f.requiredBy !== '' && !DATE.test(f.requiredBy)) p.requiredBy = 'Use a date like 2026-12-31.';
  if (!/^\d{1,3}$/.test(f.validityDays.trim()) || Number(f.validityDays) < 1 || Number(f.validityDays) > 365) p.validityDays = 'Say how many days a quote must hold, from 1 to 365.';
  if (!/^[A-Z]{3}$/.test(f.currency.trim().toUpperCase())) p.currency = 'Choose the currency quotes are made in.';
  if (f.estimatedValue.trim() !== '' && !MONEY.test(f.estimatedValue.trim())) p.estimatedValue = 'Give the estimated value as an amount, like 250000.';
  return p;
}

export interface RfqLineForm {
  productId: string;
  description: string;
  specification: string;
  quantity: string;
  unit: string;
  requiredDate: string;
}

export const emptyRfqLine = (): RfqLineForm => ({ productId: '', description: '', specification: '', quantity: '1', unit: 'each', requiredDate: '' });

export function checkRfqLine(l: RfqLineForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (l.description.trim().length < 2 || l.description.trim().length > 300) p.description = 'Describe what you want in 2 to 300 characters.';
  if (!/^\d{1,11}(\.\d{1,3})?$/.test(l.quantity.trim()) || Number(l.quantity) <= 0) p.quantity = 'The quantity is a number above zero, with up to three decimals.';
  if (l.unit.trim() === '' || l.unit.trim().length > 20) p.unit = 'Give the unit, like each, kg or box.';
  if (l.requiredDate !== '' && !DATE.test(l.requiredDate)) p.requiredDate = 'Use a date like 2026-12-31.';
  return p;
}

/** The statuses an RFQ is in while vendors can still answer it. */
export const isOpenForQuotes = (status: string, deadline: Date, now: Date): boolean => status === 'issued' && now.getTime() <= deadline.getTime();

// ── Quotes ────────────────────────────────────────────────────────────────────────────────────

export interface AskedLine {
  id: string;
  description: string;
  quantity: number;
}

export interface QuoteLineInput {
  rfqLineId: string;
  noBid: boolean;
  isAlternative: boolean;
  unitPrice: string;
  quantity: string;
  taxRate: string;
  leadTimeDays: string;
  brand: string;
  warranty: string;
  note: string;
}

export const blankQuoteLine = (rfqLineId: string, quantity: number): QuoteLineInput => ({ rfqLineId, noBid: false, isAlternative: false, unitPrice: '', quantity: String(quantity), taxRate: '0', leadTimeDays: '', brand: '', warranty: '', note: '' });

/** Problems with a quote's lines, keyed `<rfqLineId>.<field>` (or `<rfqLineId>:alt.<field>` for an alternative), plus `lines` for whole-quote ones. */
export function checkQuoteLines(asked: readonly AskedLine[], lines: readonly QuoteLineInput[], rules: { allowPartial: boolean; allowAlternatives: boolean }, forSubmit: boolean): Record<string, string> {
  const p: Record<string, string> = {};
  const key = (l: QuoteLineInput) => `${l.rfqLineId}${l.isAlternative ? ':alt' : ''}`;
  const seen = new Set<string>();
  for (const l of lines) {
    const a = asked.find((x) => x.id === l.rfqLineId);
    const k = key(l);
    if (a === undefined) {
      p[`${k}.line`] = 'That line is not part of this request.';
      continue;
    }
    if (seen.has(k)) p[`${k}.line`] = 'A line can be answered only once.';
    seen.add(k);
    if (l.isAlternative && !rules.allowAlternatives) p[`${k}.line`] = 'This request does not take alternative offers.';
    if (l.noBid) continue;
    const price = l.unitPrice.trim();
    const qty = l.quantity.trim();
    if (price === '' && !forSubmit) continue;
    if (!/^\d{1,10}(\.\d{1,2})?$/.test(price)) p[`${k}.unitPrice`] = 'Give the price for one unit, like 1250.50.';
    if (!/^\d{1,11}(\.\d{1,3})?$/.test(qty) || Number(qty) <= 0) p[`${k}.quantity`] = 'Give the quantity you offer, above zero.';
    else if (Number(qty) > a.quantity) p[`${k}.quantity`] = `You cannot offer more than the ${String(a.quantity)} asked for.`;
    else if (!l.isAlternative && !rules.allowPartial && Number(qty) !== a.quantity) p[`${k}.quantity`] = `This request needs the full ${String(a.quantity)}: partial quotes are not accepted.`;
    if (l.taxRate.trim() !== '' && (!/^\d{1,3}(\.\d{1,2})?$/.test(l.taxRate.trim()) || Number(l.taxRate) > 100)) p[`${k}.taxRate`] = 'The tax rate is a percentage from 0 to 100.';
    if (l.leadTimeDays.trim() !== '' && (!/^\d{1,4}$/.test(l.leadTimeDays.trim()))) p[`${k}.leadTimeDays`] = 'Give the lead time in whole days.';
  }
  if (forSubmit) {
    for (const a of asked) {
      if (!lines.some((l) => l.rfqLineId === a.id && !l.isAlternative)) p[`${a.id}.line`] = `Answer “${a.description}”: give a price, or mark it as not bid.`;
    }
    if (!asked.some((a) => lines.some((l) => l.rfqLineId === a.id && !l.isAlternative && !l.noBid))) p.lines = 'Quote at least one line. Marking every line “not bid” is declining the request.';
  }
  return p;
}

const toCents = (v: string): number => Math.round(Number(v) * 100);

export interface Totals {
  subtotal: number;
  tax: number;
  total: number;
}

/** In cents. Alternatives and lines not bid are not part of the total. */
export function quoteTotals(lines: readonly QuoteLineInput[]): Totals {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    if (l.noBid || l.isAlternative || l.unitPrice.trim() === '') continue;
    const net = Math.round(toCents(l.unitPrice) * Number(l.quantity));
    subtotal += net;
    tax += Math.round((net * Number(l.taxRate === '' ? '0' : l.taxRate)) / 100);
  }
  return { subtotal, tax, total: subtotal + tax };
}

// ── What the vendor sees ──────────────────────────────────────────────────────────────────────

export type VendorStage = 'new' | 'in_progress' | 'submitted' | 'revision_requested' | 'under_evaluation' | 'awarded' | 'not_awarded' | 'rejected' | 'declined' | 'expired' | 'cancelled';

export const VENDOR_STAGE: Record<VendorStage, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  new: { label: 'New', tone: 'sky' },
  in_progress: { label: 'In progress', tone: 'amber' },
  submitted: { label: 'Submitted', tone: 'green' },
  revision_requested: { label: 'Revision requested', tone: 'amber' },
  under_evaluation: { label: 'Under evaluation', tone: 'sky' },
  awarded: { label: 'Awarded to you', tone: 'green' },
  not_awarded: { label: 'Not awarded', tone: 'gray' },
  rejected: { label: 'Rejected', tone: 'red' },
  declined: { label: 'You declined', tone: 'gray' },
  expired: { label: 'Expired', tone: 'gray' },
  cancelled: { label: 'Cancelled', tone: 'red' },
};

export interface StageFacts {
  rfqStatus: string;
  inviteStatus: string;
  decision: string;
  /** The vendor has a submitted (not withdrawn) quote. */
  hasSubmitted: boolean;
  /** The vendor has a draft version. */
  hasDraft: boolean;
  /** The vendor was given at least one award. */
  wasAwarded: boolean;
}

/** The one word a vendor sees for an RFQ, in the buyer's own terms. */
export function vendorStage(f: StageFacts): VendorStage {
  if (f.rfqStatus === 'cancelled') return 'cancelled';
  if (f.inviteStatus === 'declined') return 'declined';
  if (f.rfqStatus === 'awarded') {
    if (f.wasAwarded) return 'awarded';
    return f.decision === 'rejected' ? 'rejected' : 'not_awarded';
  }
  if (f.decision === 'rejected') return 'rejected';
  if (f.decision === 'revision_requested') return 'revision_requested';
  if (f.rfqStatus === 'closed') return f.hasSubmitted ? 'under_evaluation' : 'expired';
  if (f.rfqStatus === 'issued') {
    if (f.hasSubmitted) return 'submitted';
    if (f.hasDraft) return 'in_progress';
    return f.inviteStatus === 'opened' ? 'in_progress' : 'new';
  }
  return 'new';
}

// ── The buyer's comparison sheet ──────────────────────────────────────────────────────────────

export interface CompareCell {
  noBid: boolean;
  unitPrice: number;
  quantity: number;
  lineTotal: number;
  leadTimeDays: number | null;
}

export interface CompareInput {
  vendorId: string;
  /** Primary (not alternative) lines by RFQ line id. */
  cells: Readonly<Record<string, CompareCell>>;
  taxTotal: number;
}

export interface CompareRow {
  lineId: string;
  /** Vendor ids with the lowest unit price among those bidding on this line. */
  lowest: string[];
}

export interface CompareVendor {
  vendorId: string;
  subtotal: number;
  tax: number;
  total: number;
  /** Bid on every line for the full quantity. */
  complete: boolean;
}

/** Lowest unit price per line, each vendor's total, and which vendor is lowest on a complete quote. Amounts in cents. */
export function compare(lineIds: readonly string[], inputs: readonly CompareInput[]): { rows: CompareRow[]; vendors: CompareVendor[]; lowestComplete: string[] } {
  const rows = lineIds.map((lineId) => {
    const bids = inputs.flatMap((i) => {
      const c = i.cells[lineId];
      return c === undefined || c.noBid ? [] : [{ vendorId: i.vendorId, price: c.unitPrice }];
    });
    const min = bids.length === 0 ? null : Math.min(...bids.map((b) => b.price));
    return { lineId, lowest: min === null ? [] : bids.filter((b) => b.price === min).map((b) => b.vendorId) };
  });
  const vendors = inputs.map((i) => {
    const subtotal = lineIds.reduce((s, id) => s + (i.cells[id]?.noBid === false ? i.cells[id].lineTotal : 0), 0);
    const complete = lineIds.every((id) => i.cells[id]?.noBid === false);
    return { vendorId: i.vendorId, subtotal, tax: i.taxTotal, total: subtotal + i.taxTotal, complete };
  });
  const full = vendors.filter((v) => v.complete);
  const min = full.length === 0 ? null : Math.min(...full.map((v) => v.total));
  return { rows, vendors, lowestComplete: min === null ? [] : full.filter((v) => v.total === min).map((v) => v.vendorId) };
}
