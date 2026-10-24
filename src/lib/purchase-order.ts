/** Rules for purchase orders and their amendments (design doc §9). Pure: shared by the forms and the server. Money in cents. */

export const PO_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved, not sent', tone: 'sky' },
  sent: { label: 'Sent to the vendor', tone: 'sky' },
  confirmed: { label: 'Confirmed by the vendor', tone: 'green' },
  amendment_pending: { label: 'Change waiting for approval', tone: 'amber' },
  partially_received: { label: 'Partly received', tone: 'sky' },
  received: { label: 'Received', tone: 'green' },
  partially_invoiced: { label: 'Partly invoiced', tone: 'sky' },
  invoiced: { label: 'Invoiced', tone: 'green' },
  closed: { label: 'Closed', tone: 'gray' },
  cancelled: { label: 'Cancelled', tone: 'red' },
};

export const ADVANCE_STATUS: Record<string, { label: string; tone: 'green' | 'amber' | 'red' | 'sky' | 'gray' }> = {
  draft: { label: 'Draft', tone: 'gray' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved, to be paid', tone: 'sky' },
  paid: { label: 'Paid', tone: 'green' },
  applied: { label: 'Applied to an invoice', tone: 'gray' },
  refunded: { label: 'Refunded by the vendor', tone: 'gray' },
  written_off: { label: 'Written off', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export interface PoHeaderForm {
  vendorId: string;
  categoryId: string;
  orderDate: string;
  expectedDate: string;
  currency: string;
  paymentTerms: string;
  deliveryTerms: string;
  notesToVendor: string;
  internalNotes: string;
  requiresAdvancePayment: boolean;
  noRfqReason: string;
}

export const emptyPoHeader = (today: string): PoHeaderForm => ({ vendorId: '', categoryId: '', orderDate: today, expectedDate: '', currency: '', paymentTerms: '', deliveryTerms: '', notesToVendor: '', internalNotes: '', requiresAdvancePayment: false, noRfqReason: '' });

export interface PoLineForm {
  productId: string;
  description: string;
  specification: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxRate: string;
  expectedDate: string;
}

export const emptyPoLine = (): PoLineForm => ({ productId: '', description: '', specification: '', quantity: '1', unit: 'each', unitPrice: '', discountPercent: '0', taxRate: '0', expectedDate: '' });

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function checkPoHeader(h: PoHeaderForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (h.vendorId === '') p.vendorId = 'Choose the vendor.';
  if (h.categoryId === '') p.categoryId = 'Choose the category. The vendor must be qualified in it.';
  if (!DATE.test(h.orderDate)) p.orderDate = 'Use a date like 2026-12-31.';
  if (h.expectedDate !== '' && !DATE.test(h.expectedDate)) p.expectedDate = 'Use a date like 2026-12-31.';
  if (!/^[A-Z]{3}$/.test(h.currency.trim().toUpperCase())) p.currency = 'Choose the currency.';
  return p;
}

export function checkPoLine(l: PoLineForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (l.description.trim().length < 2 || l.description.trim().length > 300) p.description = 'Describe what you are ordering in 2 to 300 characters.';
  if (!/^\d{1,11}(\.\d{1,3})?$/.test(l.quantity.trim()) || Number(l.quantity) <= 0) p.quantity = 'The quantity is a number above zero, with up to three decimals.';
  if (l.unit.trim() === '' || l.unit.trim().length > 20) p.unit = 'Give the unit, like each, kg or box.';
  if (!/^\d{1,10}(\.\d{1,2})?$/.test(l.unitPrice.trim())) p.unitPrice = 'Give the price for one unit, like 1250.50.';
  if (l.discountPercent.trim() !== '' && (!/^\d{1,3}(\.\d{1,2})?$/.test(l.discountPercent.trim()) || Number(l.discountPercent) > 100)) p.discountPercent = 'The discount is a percentage from 0 to 100.';
  if (l.taxRate.trim() !== '' && (!/^\d{1,3}(\.\d{1,2})?$/.test(l.taxRate.trim()) || Number(l.taxRate) > 100)) p.taxRate = 'The tax rate is a percentage from 0 to 100.';
  if (l.expectedDate !== '' && !DATE.test(l.expectedDate)) p.expectedDate = 'Use a date like 2026-12-31.';
  return p;
}

const cents = (v: string): number => Math.round(Number(v) * 100);

export interface LineAmounts {
  net: number;
  tax: number;
  total: number;
}

/** One line: quantity times price less the discount, then tax on that. */
export function lineAmounts(l: Pick<PoLineForm, 'quantity' | 'unitPrice' | 'discountPercent' | 'taxRate'>): LineAmounts {
  const net = Math.round(cents(l.unitPrice) * Number(l.quantity) * (1 - Number(l.discountPercent === '' ? '0' : l.discountPercent) / 100));
  const tax = Math.round((net * Number(l.taxRate === '' ? '0' : l.taxRate)) / 100);
  return { net, tax, total: net + tax };
}

export function orderTotals(lines: readonly Pick<PoLineForm, 'quantity' | 'unitPrice' | 'discountPercent' | 'taxRate'>[]): { subtotal: number; tax: number; total: number } {
  let subtotal = 0;
  let tax = 0;
  for (const l of lines) {
    const a = lineAmounts(l);
    subtotal += a.net;
    tax += a.tax;
  }
  return { subtotal, tax, total: subtotal + tax };
}

export const toMoney = (c: number): string => (c / 100).toFixed(2);

export interface SnapshotLine {
  description: string;
  quantity: string;
  unit: string;
  unitPrice: string;
  discountPercent: string;
  taxRate: string;
  expectedDate: string | null;
}

export interface Snapshot {
  total: string;
  expectedDate: string | null;
  paymentTerms: string | null;
  deliveryTerms: string | null;
  requiresAdvancePayment: boolean;
  lines: SnapshotLine[];
}

/** What changed between two versions of an order, in words a vendor can read. */
export function describeChanges(before: Snapshot, after: Snapshot): string[] {
  const out: string[] = [];
  if (before.total !== after.total) out.push(`The order total changed from ${before.total} to ${after.total}.`);
  if (before.expectedDate !== after.expectedDate) out.push(`Expected delivery changed from ${before.expectedDate ?? 'not set'} to ${after.expectedDate ?? 'not set'}.`);
  if (before.paymentTerms !== after.paymentTerms) out.push('The payment terms changed.');
  if (before.deliveryTerms !== after.deliveryTerms) out.push('The delivery terms changed.');
  if (before.requiresAdvancePayment !== after.requiresAdvancePayment) out.push(after.requiresAdvancePayment ? 'An advance payment is now required.' : 'An advance payment is no longer required.');
  const key = (l: SnapshotLine) => l.description;
  for (const a of after.lines) {
    const b = before.lines.find((x) => key(x) === key(a));
    if (b === undefined) out.push(`Added: ${a.description}, ${a.quantity} ${a.unit} at ${a.unitPrice}.`);
    else if (b.quantity !== a.quantity || b.unitPrice !== a.unitPrice || b.discountPercent !== a.discountPercent || b.taxRate !== a.taxRate || b.expectedDate !== a.expectedDate) {
      const parts: string[] = [];
      if (b.quantity !== a.quantity) parts.push(`quantity ${b.quantity} to ${a.quantity}`);
      if (b.unitPrice !== a.unitPrice) parts.push(`price ${b.unitPrice} to ${a.unitPrice}`);
      if (b.discountPercent !== a.discountPercent) parts.push(`discount ${b.discountPercent}% to ${a.discountPercent}%`);
      if (b.taxRate !== a.taxRate) parts.push(`tax ${b.taxRate}% to ${a.taxRate}%`);
      if (b.expectedDate !== a.expectedDate) parts.push(`date ${b.expectedDate ?? 'none'} to ${a.expectedDate ?? 'none'}`);
      out.push(`${a.description}: ${parts.join(', ')}.`);
    }
  }
  for (const b of before.lines) if (!after.lines.some((a) => key(a) === key(b))) out.push(`Removed: ${b.description}.`);
  return out;
}

/** Does a change to an order need approving again? Any price change does; so does a rise in value beyond the tolerance (percent). */
export function amendmentNeedsApproval(before: Snapshot, after: Snapshot, tolerancePercent: number): boolean {
  const priceChanged = after.lines.some((a) => {
    const b = before.lines.find((x) => x.description === a.description);
    return b?.unitPrice !== a.unitPrice || b.discountPercent !== a.discountPercent || b.taxRate !== a.taxRate;
  });
  if (priceChanged || before.requiresAdvancePayment !== after.requiresAdvancePayment) return true;
  const was = cents(before.total);
  const now = cents(after.total);
  return now > was && (was === 0 || ((now - was) / was) * 100 > tolerancePercent);
}

/** The most an advance may be: the order's total less any other advance already live for it (cents). */
export const advanceCeiling = (orderTotal: number, otherLive: number): number => Math.max(0, orderTotal - otherLive);

export function checkAdvance(amount: string, ceilingCents: number, dueDate: string, reason: string): Record<string, string> {
  const p: Record<string, string> = {};
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(amount.trim()) || Number(amount) <= 0) p.amount = 'Give the advance as an amount above zero.';
  else if (cents(amount) > ceilingCents) p.amount = `An advance cannot be more than ${toMoney(ceilingCents)}, the order total.`;
  if (dueDate !== '' && !DATE.test(dueDate)) p.dueDate = 'Use a date like 2026-12-31.';
  if (reason.trim().length < 3) p.reason = 'Say why an advance is needed.';
  return p;
}
