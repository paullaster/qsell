/** What an M-Pesa payout to a vendor looks like: which platform operation, with which fields. Pure. */
import type { DestinationKind } from './vendor-profile';

export type PayoutOperation = 'b2c' | 'b2b_paybill' | 'b2b_buygoods';

export interface PayoutPlan {
  operation: PayoutOperation;
  input: Record<string, string>;
}

/** M-Pesa moves whole shillings: the part after the point must be zero. Returns the shillings, or null. */
export function wholeShillings(cashAmount: string): string | null {
  const m = /^(\d{1,12})(?:\.(\d{1,4}))?$/.exec(cashAmount.trim());
  if (m === null) return null;
  if (/[1-9]/.test(m[2] ?? '')) return null;
  return Number(m[1]) > 0 ? String(Number(m[1])) : null;
}

/** The plan for paying `shillings` to a destination of this kind. `number` is the phone (2547…), paybill or till. */
export function payoutPlan(kind: DestinationKind, number: string, reference: string | null, shillings: string, voucherNo: string): PayoutPlan | null {
  const remarks = `Payment ${voucherNo}`.slice(0, 100);
  if (kind === 'mpesa_phone') return { operation: 'b2c', input: { phone: number, amount: shillings, commandId: 'BusinessPayment', remarks } };
  if (kind === 'mpesa_paybill') return { operation: 'b2b_paybill', input: { partyB: number, amount: shillings, accountReference: (reference ?? voucherNo).slice(0, 13), remarks } };
  if (kind === 'mpesa_till') return { operation: 'b2b_buygoods', input: { partyB: number, amount: shillings, accountReference: (reference ?? voucherNo).slice(0, 13), remarks } };
  return null;
}
