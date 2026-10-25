import { has } from '@/lib/values';

export type VoucherStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'reversed' | 'cancelled';
export type VoucherKind = 'invoices' | 'advance' | 'on_account';

type Tone = 'green' | 'amber' | 'red' | 'sky' | 'gray';

export const VOUCHER_STATUS: Record<VoucherStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'gray' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved, to be paid', tone: 'sky' },
  paid: { label: 'Paid', tone: 'green' },
  reversed: { label: 'Reversed', tone: 'red' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

export const VOUCHER_KIND: Record<VoucherKind, string> = { invoices: 'Payment of invoices', advance: 'Advance payment', on_account: 'Payment on account' };

/** States in which a voucher still holds a claim on the invoices (or the advance) it names. */
export const LIVE_VOUCHER: readonly VoucherStatus[] = ['draft', 'pending_approval', 'approved'];

export const DEFAULT_THREE_EYES_ABOVE_CENTS = 10_000_000;

const money = (s: string): boolean => /^\d+(\.\d{1,2})?$/.test(s.trim()) && Number(s) > 0;
export const toCents = (s: string): number => Math.round(Number(s) * 100);
export const fromCents = (c: number): string => (c / 100).toFixed(2);

export interface VoucherHeaderForm {
  kind: VoucherKind;
  vendorId: string;
  methodId: string;
  narration: string;
  /** For an advance voucher: the advance payment document being paid. */
  advanceId: string;
  /** For a payment on account: how much, since there is no invoice to say. */
  amount?: string;
}

export interface AllocationForm {
  purchaseInvoiceId: string;
  amount: string;
  /** Close what is left on the invoice after this payment as tolerance (only when small enough). */
  closeRemainder?: boolean;
}

export function checkVoucherHeader(h: VoucherHeaderForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (!has(h.vendorId)) p.vendorId = 'Choose the vendor.';
  if (!has(h.methodId)) p.methodId = 'Choose how it will be paid.';
  if (h.narration.length > 500) p.narration = 'The note is too long (500 characters at most).';
  if (h.kind === 'advance' && !has(h.advanceId)) p.advanceId = 'Choose the advance payment to pay.';
  if (h.kind === 'on_account') {
    if (!money(h.amount ?? '')) p.amount = 'Enter the amount to pay, above zero (up to 2 decimals).';
    if (h.narration.trim() === '') p.narration = 'Say what the payment on account is for.';
  }
  return p;
}

export interface OpenItem {
  purchaseInvoiceId: string;
  /** What is still open on the invoice, less what other vouchers already hold, in cents. */
  availableCents: number;
}

/** Each allocation is a positive amount, for an invoice that is open, once, and within what is available. */
export function checkAllocations(items: readonly OpenItem[], allocations: readonly AllocationForm[]): { problems: Record<string, string>; totalCents: number } {
  const problems: Record<string, string> = {};
  const byId = new Map(items.map((i) => [i.purchaseInvoiceId, i.availableCents]));
  const seen = new Set<string>();
  let totalCents = 0;
  if (allocations.length === 0) problems.allocations = 'Choose at least one invoice to pay.';
  allocations.forEach((a, i) => {
    const key = `allocation.${String(i)}`;
    if (seen.has(a.purchaseInvoiceId)) problems[key] = 'Each invoice can be on the voucher once.';
    seen.add(a.purchaseInvoiceId);
    if (!money(a.amount)) {
      problems[key] = 'Enter the amount to pay, above zero (up to 2 decimals).';
      return;
    }
    const available = byId.get(a.purchaseInvoiceId);
    if (available === undefined) problems[key] = 'That invoice is not open for this vendor.';
    else if (toCents(a.amount) > available) problems[key] = `Only ${fromCents(available)} of this invoice is open for payment.`;
    else totalCents += toCents(a.amount);
  });
  return { problems, totalCents };
}

/** Above the configured value, three different people must create, approve and release a payment. */
export const needsThreePeople = (amountCents: number, thresholdCents: number): boolean => thresholdCents > 0 && amountCents >= thresholdCents;

/** Returns the plain reason an approver is not allowed, or null. */
export function approvalRefusal(approver: string, creator: string | null): string | null {
  if (creator !== null && approver === creator) return 'You prepared this payment, so another person has to approve it.';
  return null;
}

/** Returns the plain reason a releaser is not allowed, or null. Releasing is paying: the money leaves. */
export function releaseRefusal(releaser: string, creator: string | null, approver: string | null, threePeople: boolean): string | null {
  if (!threePeople) return null;
  if (releaser === creator || releaser === approver) return 'This payment is large enough that a third person, who neither prepared nor approved it, has to pay it.';
  return null;
}

export type AgeBucket = 'not_due' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus';
export const AGE_BUCKETS: { key: AgeBucket; label: string }[] = [
  { key: 'not_due', label: 'Not yet due' },
  { key: 'd1_30', label: '1–30 days late' },
  { key: 'd31_60', label: '31–60 days late' },
  { key: 'd61_90', label: '61–90 days late' },
  { key: 'd90_plus', label: 'Over 90 days late' },
];

const DAY = 86_400_000;

/** Which age column an open invoice falls in on `asOf` (both YYYY-MM-DD). With no due date the invoice date stands in. */
export function ageBucket(dueDate: string | null, invoiceDate: string, asOf: string): AgeBucket {
  const due = Date.parse(`${dueDate ?? invoiceDate}T00:00:00Z`);
  const days = Math.floor((Date.parse(`${asOf}T00:00:00Z`) - due) / DAY);
  if (days <= 0) return 'not_due';
  if (days <= 30) return 'd1_30';
  if (days <= 60) return 'd31_60';
  if (days <= 90) return 'd61_90';
  return 'd90_plus';
}
