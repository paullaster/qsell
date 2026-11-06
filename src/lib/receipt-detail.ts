/**
 * The arithmetic and grouping behind the receipt page. Pure. Money is handled in whole cents so
 * nothing drifts: the server still checks every amount again.
 */
export interface OpenInvoice {
  entryId: string;
  remaining: string;
}

/** An invoice as the person choosing where money goes sees it. */
export interface OpenInvoiceView extends OpenInvoice {
  /** "Invoice INV-1", or "Order ORD-1" when no invoice number was issued. */
  documentNo: string;
  order: string | null;
  lines: { text: string; total: string }[];
  moreLines: number;
  dueDate: string | null;
  currency: string | null;
}

export const toCents = (amount: string): number => Math.round(Number(amount) * 100);
export const fromCents = (cents: number): string => (cents / 100).toFixed(2);

/** Fills invoices oldest first (the list order) until the unapplied amount is used up. */
export function fillOldest(open: readonly OpenInvoice[], unapplied: string): Record<string, string> {
  let left = toCents(unapplied);
  const out: Record<string, string> = {};
  for (const inv of open) {
    if (left <= 0) break;
    const take = Math.min(left, toCents(inv.remaining));
    out[inv.entryId] = fromCents(take);
    left -= take;
  }
  return out;
}

/** The total of what was typed, in cents; anything that is not a number counts as nothing. */
export function chosenCents(amounts: Readonly<Record<string, string>>): number {
  return Object.values(amounts).reduce((n, v) => n + (Number.isFinite(Number(v)) && Number(v) > 0 ? toCents(v) : 0), 0);
}

export const canApply = (amounts: Readonly<Record<string, string>>, unapplied: string): boolean => {
  const chosen = chosenCents(amounts);
  return chosen > 0 && chosen <= toCents(unapplied);
};

/** The rows with an amount to apply, as the server expects them. */
export const applications = (amounts: Readonly<Record<string, string>>): { entryId: string; amount: string }[] =>
  Object.entries(amounts).filter(([, v]) => Number(v) > 0).map(([entryId, amount]) => ({ entryId, amount }));

export interface ApplicationRow {
  applicationId: string;
  at: string;
  undone: boolean;
  invoiceNo: string;
  amount: string;
  order?: string | null;
  /** The order behind the invoice, so the numbers can link to it. */
  orderId?: string | null;
  /** A tax invoice was issued for that order; if not, the title names the order itself. */
  invoiceIssued?: boolean;
  lines?: { text: string; total: string }[];
  moreLines?: number;
}

export interface ApplicationGroup {
  applicationId: string;
  at: string;
  undone: boolean;
  totalCents: number;
  rows: { invoiceNo: string; amount: string; order: string | null; orderId: string | null; invoiceIssued: boolean; lines: { text: string; total: string }[]; moreLines: number }[];
}

/** One application can cover several invoices; it is shown, and undone, as a whole. */
export function groupApplications(rows: readonly ApplicationRow[]): ApplicationGroup[] {
  const groups = new Map<string, ApplicationGroup>();
  for (const a of rows) {
    const g = groups.get(a.applicationId) ?? { applicationId: a.applicationId, at: a.at, undone: a.undone, totalCents: 0, rows: [] };
    g.totalCents += toCents(a.amount);
    g.rows.push({ invoiceNo: a.invoiceNo, amount: a.amount, order: a.order ?? null, orderId: a.orderId ?? null, invoiceIssued: a.invoiceIssued ?? false, lines: a.lines ?? [], moreLines: a.moreLines ?? 0 });
    groups.set(a.applicationId, g);
  }
  return [...groups.values()];
}

/** What to tell the person after a receipt is posted. */
export function postedMessage(applied: string, glPosted: boolean, formatMoney: (v: string) => string): string {
  const appliedText = Number(applied) > 0 ? ` and applied ${formatMoney(applied)} to invoices` : '';
  return `Posted${appliedText}${glPosted ? '' : ' (general ledger posting is not switched on yet)'}.`;
}

/** True when a reason must come with a written comment. */
export const needsComment = (meta: Record<string, string> | undefined): boolean => meta?.requiresComment === '1';

/** What to ask the server for when a draft is posted, from the mode picked and the invoices chosen. */
export function allocationFor(mode: string | undefined, chosen: Readonly<Record<string, string>>): 'oldest_first' | 'none' | { entryId: string; amount: string }[] {
  if (mode === 'none') return 'none';
  if (mode === 'choose') return applications(chosen);
  return 'oldest_first';
}
