import { has } from '@/lib/values';

export type PettyStatus = 'draft' | 'pending_approval' | 'approved' | 'paid' | 'cancelled' | 'reversed';
type Tone = 'green' | 'amber' | 'red' | 'sky' | 'gray';

export const PETTY_STATUS: Record<PettyStatus, { label: string; tone: Tone }> = {
  draft: { label: 'Draft', tone: 'gray' },
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved, to be paid', tone: 'sky' },
  paid: { label: 'Paid', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
  reversed: { label: 'Reversed', tone: 'red' },
};

export const REPLENISHMENT_STATUS: Record<string, { label: string; tone: Tone }> = {
  pending_approval: { label: 'Waiting for approval', tone: 'amber' },
  approved: { label: 'Approved, to be paid', tone: 'sky' },
  paid: { label: 'Paid', tone: 'green' },
  cancelled: { label: 'Cancelled', tone: 'gray' },
};

/** States in which a voucher still counts against the day's limit and the cash on hand. */
export const PETTY_LIVE: readonly PettyStatus[] = ['draft', 'pending_approval', 'approved'];

const money = (s: string): boolean => /^\d+(\.\d{1,2})?$/.test(s.trim()) && Number(s) > 0;
export const cents = (s: string): number => Math.round(Number(s) * 100);
export const fmt = (c: number): string => (c / 100).toFixed(2);

export interface FloatForm {
  code: string;
  name: string;
  bankAccountId: string;
  glAccountId: string;
  custodianId: string;
  floatAmount: string;
  perVoucherLimit: string;
  dailyLimit: string;
  minimumBalance: string;
}

export function checkFloatForm(f: FloatForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,19}$/.test(f.code.trim())) p.code = 'The code is letters, digits, dots, dashes or underscores, up to 20 characters.';
  if (f.name.trim() === '' || f.name.trim().length > 120) p.name = 'Give the float a name (120 characters at most).';
  if (!has(f.bankAccountId)) p.bankAccountId = 'Choose the cash account the float is kept in.';
  if (!has(f.glAccountId)) p.glAccountId = 'Choose the ledger account for the cash.';
  if (!has(f.custodianId)) p.custodianId = 'Choose who looks after the cash.';
  if (!money(f.floatAmount)) p.floatAmount = 'Enter the amount the float is topped up to.';
  if (!money(f.perVoucherLimit)) p.perVoucherLimit = 'Enter the most one voucher may pay.';
  if (!money(f.dailyLimit)) p.dailyLimit = 'Enter the most that may be paid in a day.';
  if (f.minimumBalance.trim() !== '' && !/^\d+(\.\d{1,2})?$/.test(f.minimumBalance.trim())) p.minimumBalance = 'Enter an amount, or leave empty.';
  if (Object.keys(p).length > 0) return p;
  if (cents(f.perVoucherLimit) > cents(f.dailyLimit)) p.dailyLimit = 'The daily limit cannot be less than the limit for one voucher.';
  if (cents(f.perVoucherLimit) > cents(f.floatAmount)) p.perVoucherLimit = 'One voucher cannot be allowed to pay more than the float holds.';
  if (f.minimumBalance.trim() !== '' && cents(f.minimumBalance) > cents(f.floatAmount)) p.minimumBalance = 'The minimum cannot be more than the float.';
  return p;
}

export interface PettyVoucherForm {
  floatId: string;
  kind: 'expense' | 'vendor_invoice';
  payeeName: string;
  description: string;
  receiptRef: string;
  amount: string;
  expenseAccountId: string;
  purchaseInvoiceId: string;
}

export function checkPettyVoucher(f: PettyVoucherForm): Record<string, string> {
  const p: Record<string, string> = {};
  if (!has(f.floatId)) p.floatId = 'Choose the float the money comes from.';
  if (f.payeeName.trim() === '' || f.payeeName.trim().length > 120) p.payeeName = 'Say who is paid (120 characters at most).';
  if (f.description.trim() === '' || f.description.length > 300) p.description = 'Say what the payment is for (300 characters at most).';
  if (f.receiptRef.trim() === '' || f.receiptRef.trim().length > 60) p.receiptRef = 'Enter the number on the receipt.';
  if (!money(f.amount)) p.amount = 'Enter the amount, above zero (up to 2 decimals).';
  if (f.kind === 'expense' && !has(f.expenseAccountId)) p.expenseAccountId = 'Choose the expense it is booked to.';
  if (f.kind === 'vendor_invoice' && !has(f.purchaseInvoiceId)) p.purchaseInvoiceId = 'Choose the vendor invoice being paid.';
  return p;
}

/** Returns the plain reason a voucher is refused for its size, or null. */
export function overLimit(amountCents: number, perVoucherCents: number): string | null {
  return amountCents > perVoucherCents ? `This float may pay at most ${fmt(perVoucherCents)} on one voucher.` : null;
}

export function overDaily(alreadyCents: number, amountCents: number, dailyCents: number): string | null {
  return alreadyCents + amountCents > dailyCents ? `This would take today’s payments from this float to ${fmt(alreadyCents + amountCents)}, above its daily limit of ${fmt(dailyCents)}.` : null;
}

/** A float that has fallen below its minimum accepts no new voucher until it is topped up. */
export function floatLow(balanceCents: number, minimumCents: number): string | null {
  return balanceCents < minimumCents ? `The float has fallen to ${fmt(balanceCents)}, below its minimum of ${fmt(minimumCents)}. Top it up first.` : null;
}

export function notEnoughCash(balanceCents: number, amountCents: number): string | null {
  return amountCents > balanceCents ? `There is only ${fmt(balanceCents)} in the float.` : null;
}

/** How much tops the float back up to its amount. Zero when it is already full. */
export const topUpAmount = (floatCents: number, balanceCents: number): number => Math.max(0, floatCents - balanceCents);
