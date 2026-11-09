/**
 * Matching a courier's invoice to the charges we have kept for its parcels. Pure rules: what a typed invoice must say, and where an invoice
 * stands against the charges matched to it. The database and screens follow them.
 */

export const INVOICE_STATES = ['open', 'agreed', 'short', 'over'] as const;
export type InvoiceState = (typeof INVOICE_STATES)[number];

export const INVOICE_WORDS: Record<InvoiceState, string> = {
  open: 'Nothing matched yet',
  agreed: 'Agrees with our charges',
  short: 'We have fewer charges than the invoice',
  over: 'We have more charges than the invoice',
};

const cents = (n: number): number => Math.round(n * 100);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export interface CourierInvoiceInput {
  courierName: string;
  invoiceNo: string;
  invoiceDate: string;
  totalCents: number;
  note: string | null;
}

/** An invoice as typed: which courier, its number, its day (not in the future), and what it totals (more than nothing, to the cent). */
export function invoiceProblem(raw: { courierName?: unknown; invoiceNo?: unknown; invoiceDate?: unknown; total?: unknown; note?: unknown }, today: string): { error: string } | { value: CourierInvoiceInput } {
  const courierName = typeof raw.courierName === 'string' ? raw.courierName.trim().slice(0, 120) : '';
  if (courierName.length < 2) return { error: 'Choose the courier the invoice is from.' };
  const invoiceNo = typeof raw.invoiceNo === 'string' ? raw.invoiceNo.trim().slice(0, 60) : '';
  if (invoiceNo === '') return { error: 'Type the number printed on the courier\'s invoice.' };
  const invoiceDate = typeof raw.invoiceDate === 'string' ? raw.invoiceDate : '';
  if (!DAY.test(invoiceDate) || Number.isNaN(new Date(`${invoiceDate}T00:00:00Z`).getTime())) return { error: 'Choose the day on the invoice.' };
  if (invoiceDate > today) return { error: 'The day on the invoice cannot be in the future.' };
  const total = raw.total;
  if (typeof total !== 'number' || !Number.isFinite(total) || total <= 0 || total > 100_000_000) return { error: 'Type what the invoice totals, in shillings.' };
  const note = typeof raw.note === 'string' && raw.note.trim() !== '' ? raw.note.trim().slice(0, 300) : null;
  return { value: { courierName, invoiceNo, invoiceDate, totalCents: cents(total), note } };
}

/** Where an invoice stands: nothing matched, agreeing with the charges matched to it, or short or over by the difference (in cents, the charges less the invoice). */
export function reconcile(invoiceCents: number, matchedCents: number): { state: InvoiceState; differenceCents: number } {
  if (matchedCents === 0) return { state: 'open', differenceCents: -invoiceCents };
  const differenceCents = matchedCents - invoiceCents;
  if (differenceCents === 0) return { state: 'agreed', differenceCents };
  return { state: differenceCents < 0 ? 'short' : 'over', differenceCents };
}

/** A chosen list of charges: whole ids, none twice, at least one, at most 200 at a time. */
export function chargeIds(raw: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Choose at least one charge.' };
  if (raw.length > 200) return { ok: false, error: 'Match at most 200 charges at a time.' };
  const ids: string[] = [];
  for (const id of raw) {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return { ok: false, error: 'One of the charges could not be read.' };
    if (!ids.includes(id)) ids.push(id);
  }
  return { ok: true, ids };
}
