import { has } from '@/lib/values';

/**
 * A shopper who has paid and holds the provider's message with its transaction code can tell us the code, and the shop asks the
 * provider about it. This is the pure part: what may be claimed, what a code looks like, and what the answers mean. Everything here is
 * decided from its inputs alone.
 */

/** The ways to pay that can be claimed for an order. The others are paid on account, to the rider or at the counter. */
export const CLAIMABLE_METHODS = ['mpesa_daraja', 'pesapal_v3', 'jenga_hq', 'kcb_buni'] as const;
export type ClaimableMethod = (typeof CLAIMABLE_METHODS)[number];

export const isClaimableMethod = (value: unknown): value is ClaimableMethod => typeof value === 'string' && (CLAIMABLE_METHODS as readonly string[]).includes(value);

/** The ways whose own interface can look a payment up by the code the shopper holds. The rest are saved for a person to confirm. */
export const LOOKUP_BY_CODE: readonly ClaimableMethod[] = ['mpesa_daraja'];

export const canLookUpByCode = (method: ClaimableMethod): boolean => LOOKUP_BY_CODE.includes(method);

/** What a shopper typed as a code, written the way the provider writes it: no spaces or dashes, capitals. */
export function normaliseCode(raw: unknown): string {
  return typeof raw === 'string' ? raw.replace(/[\s\-_.]/g, '').toUpperCase() : '';
}

export type CodeCheck = { ok: true; code: string } | { ok: false; error: string };

/** Whether what was typed can be a code for this way of paying, in words for the shopper. An M-Pesa code is ten letters and digits. */
export function checkCode(method: ClaimableMethod, raw: unknown): CodeCheck {
  const code = normaliseCode(raw);
  if (code === '') return { ok: false, error: 'Enter the transaction code from your payment message.' };
  if (method === 'mpesa_daraja') {
    if (!/^[A-Z0-9]{10}$/.test(code)) return { ok: false, error: 'An M-Pesa code is 10 letters and numbers, for example QGH7RT61SV. Copy it from your M-Pesa message.' };
    return { ok: true, code };
  }
  if (!/^[A-Z0-9]{6,40}$/.test(code)) return { ok: false, error: 'That does not look like a transaction code. Copy it from your payment message.' };
  return { ok: true, code };
}

/** What an order must be like for its payment to be completed by the shopper. */
export interface PayableOrder {
  status: string;
  paymentStatus: string;
  paymentMethod: string;
  /** What is still to be paid through a gateway. */
  amountDue: number;
}

export type Payable = { ok: true } | { ok: false; reason: string };

/**
 * Whether the shopper may still complete the payment of this order. It is the same for every way of reaching it: an order that is
 * already paid, cancelled, refunded or paid some other way has nothing to complete.
 */
export function canCompletePayment(order: PayableOrder): Payable {
  if (order.paymentStatus === 'paid' || order.paymentStatus === 'reconciled') return { ok: false, reason: 'This order is already paid.' };
  if (order.status === 'cancelled' || order.status === 'refunded') return { ok: false, reason: 'This order was cancelled, so it cannot be paid.' };
  if (!['pending', 'failed'].includes(order.status)) return { ok: false, reason: 'This order has already moved on, so there is nothing left to pay.' };
  if (!(CLAIMABLE_METHODS as readonly string[]).includes(order.paymentMethod)) return { ok: false, reason: 'This order is not paid through an online payment.' };
  if (order.amountDue <= 0) return { ok: false, reason: 'Nothing is left to pay on this order.' };
  if (!['unpaid', 'pending_verification', 'failed'].includes(order.paymentStatus)) return { ok: false, reason: 'This order is being looked at by the shop.' };
  return { ok: true };
}

/** A Kenyan mobile number as its nine significant digits (7XXXXXXXX), with any hidden digits kept as `*`. Null when it is not one. */
function significantDigits(value: string): string | null {
  const kept = value.replace(/[^0-9*]/g, '');
  let nine = kept;
  if (kept.startsWith('254')) nine = kept.slice(3);
  else if (kept.startsWith('0')) nine = kept.slice(1);
  return nine.length === 9 ? nine : null;
}

/**
 * Whether the phone that paid is one of the phones the order knows. M-Pesa may show the payer with the middle of the number hidden
 * (`2547*****123`), so a hidden digit matches any digit. Null when the payer cannot be read or the order has no phone to compare, so
 * nothing is held back on a guess.
 */
export function payerMatches(payer: string | null | undefined, phones: readonly (string | null | undefined)[]): boolean | null {
  if (!has(payer)) return null;
  const token = /[0-9*]{9,13}/.exec(payer)?.[0];
  const shown = token === undefined ? null : significantDigits(token);
  if (shown === null) return null;
  const known = phones.map((p) => (has(p) ? significantDigits(p) : null)).filter((p): p is string => p !== null && !p.includes('*'));
  if (known.length === 0) return null;
  return known.some((phone) => Array.from({ length: shown.length }, (_, at) => at).every((at) => shown[at] === '*' || shown[at] === phone[at]));
}

/** What a shopper is told about a claim, from where it got to. Plain words: no provider codes, no amounts of anyone else's money. */
export type ClaimStage = 'confirmed' | 'checking' | 'held' | 'not_found' | 'amount_differs' | 'used' | 'too_early' | 'saved' | 'unavailable' | 'busy';

export const CLAIM_WORDS: Record<ClaimStage, string> = {
  confirmed: 'Thank you. We found your payment and your order is now paid.',
  checking: 'We are checking your payment with the provider. This can take a minute; you can leave this page open.',
  held: 'We found your payment, but it was made from a different phone number than the one on this order, so a person at the shop has to confirm it. We have told them, and we will be in touch.',
  not_found: 'The provider has no completed payment with that code. Check the code in your message and try again, or pay again below.',
  amount_differs: 'That payment is not for the amount of this order, so we cannot match it. Check the code, or contact the shop with it.',
  used: 'That code has already been used for a payment, so it cannot be used again here. If this is your payment, contact the shop with it.',
  too_early: 'That payment was made before this order was placed, so it cannot be matched to it. Check the code in your message.',
  saved: 'We could not check this payment with the provider automatically, so we have saved your code with the order. A person at the shop will confirm it and tell you.',
  unavailable: 'We cannot check payments with this provider right now. We have saved your code with the order, and a person at the shop will confirm it.',
  busy: 'Too many tries for this order. Please wait a few minutes and try again.',
};

const STAGE_OF_OUTCOME: Record<string, ClaimStage> = {
  PAYER_DIFFERS: 'held',
  STATUS_AMOUNT_MISMATCH: 'amount_differs',
  AMOUNT_MISMATCH: 'amount_differs',
  REFERENCE_ALREADY_USED: 'used',
  REFERENCE_REUSED: 'used',
  BEFORE_ORDER: 'too_early',
};

/** The stage a verification outcome code means to the shopper. Anything not listed (the platform has no such payment, or says something new) is "not found". */
export const stageOfOutcome = (code: string | null | undefined): ClaimStage => STAGE_OF_OUTCOME[code ?? ''] ?? 'not_found';
