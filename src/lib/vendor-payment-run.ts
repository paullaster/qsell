/** A cell that a spreadsheet might read as a formula is made harmless (same rule as the bank files). */
function csvCell(value: string): string {
  const safe = /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export type RunStatus = 'draft' | 'pending_approval' | 'approved' | 'released' | 'confirmed' | 'cancelled';
type Tone = 'green' | 'amber' | 'red' | 'sky' | 'gray';

export const RUN_STATUS: Record<RunStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'gray' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved, to be released', tone: 'sky' },
  released: { label: 'Released, waiting for the bank', tone: 'sky' },
  confirmed: { label: 'Paid', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export const MAX_RUN_LINES = 500;

/** Is the invoice due on or before `dueOn`? With no due date, the invoice date stands in (as in the ageing). */
export const dueOnOrBefore = (dueDate: string | null, invoiceDate: string, dueOn: string): boolean => (dueDate ?? invoiceDate) <= dueOn;

/** Cheque numbers in a row from the first, keeping its zeros ("000120" then "000121"). Null when the start is not a number we can count from. */
export function chequeNumbers(first: string, count: number): string[] | null {
  const start = first.trim();
  if (!/^\d{1,12}$/.test(start) || count < 1) return null;
  const width = start.length;
  const base = Number(start);
  return Array.from({ length: count }, (_, i) => String(base + i).padStart(width, '0'));
}

export interface ChequeLine {
  chequeNo: string;
  payee: string;
  amountCents: number;
  voucherNo: string;
}

/** The list that goes to whoever writes the cheques: number, payee, amount, voucher. Pure, so it can be rebuilt and checked against its fingerprint. */
export function buildChequeSchedule(lines: readonly ChequeLine[], currency: string, date: string): string {
  const header = ['Cheque number', 'Payee', 'Amount', 'Currency', 'Date', 'Voucher'];
  const rows = lines.map((l) => [l.chequeNo, l.payee, (l.amountCents / 100).toFixed(2), currency, date, l.voucherNo]);
  return `${[header, ...rows].map((r) => r.map((c) => csvCell(c)).join(',')).join('\r\n')}\r\n`;
}

/** Whoever released a run cannot be the one who confirms the bank paid it. */
export function confirmRefusal(confirmer: string, releaser: string | null): string | null {
  return releaser !== null && confirmer === releaser ? 'The person who released the run cannot be the one who confirms it was paid.' : null;
}

export interface Suggestion {
  vendorId: string;
  vendorName: string;
  items: { purchaseInvoiceId: string; availableCents: number }[];
}

/** Applies the minimum and maximum to each vendor's total; a vendor outside them is left out with the reason. */
export function applyLimits(suggestions: readonly Suggestion[], minCents: number | null, maxCents: number | null): { kept: Suggestion[]; left: { vendorId: string; vendorName: string; reason: string }[] } {
  const kept: Suggestion[] = [];
  const left: { vendorId: string; vendorName: string; reason: string }[] = [];
  for (const s of suggestions) {
    const total = s.items.reduce((n, i) => n + i.availableCents, 0);
    if (minCents !== null && total < minCents) left.push({ vendorId: s.vendorId, vendorName: s.vendorName, reason: `Below the minimum (${(total / 100).toFixed(2)}).` });
    else if (maxCents !== null && total > maxCents) left.push({ vendorId: s.vendorId, vendorName: s.vendorName, reason: `Above the maximum (${(total / 100).toFixed(2)}).` });
    else kept.push(s);
  }
  return { kept, left };
}
