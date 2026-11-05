/**
 * Money taken at the door. A delivery can be marked to be paid in cash when it arrives; the rider collects exactly what is due, it
 * goes into the rider's custody until handed in, and the order is paid. These are the rules only: when a delivery may be marked, what
 * is due, whether what the rider says they collected is right, and how custody adds up. The database and screens follow them.
 */

export const CUSTODY_KINDS = ['collected', 'handed_in', 'adjusted'] as const;
export type CustodyKind = (typeof CUSTODY_KINDS)[number];

export const CUSTODY_WORDS: Record<CustodyKind, string> = {
  collected: 'Collected at a door',
  handed_in: 'Handed in',
  adjusted: 'Adjusted',
};

/** Whole cents, so sums are exact. */
export const toCents = (value: string | number): number => Math.round(Number(value) * 100);
export const fromCents = (cents: number): string => (cents / 100).toFixed(2);

export interface MarkFacts {
  /** `own_fleet` or `courier`. */
  method: string;
  /** The delivery's state now. */
  status: string;
  orderPaymentStatus: string;
  orderPaymentMethod: string;
  orderStatus: string;
  orderCurrency: string;
  baseCurrency: string;
  /** What gift cards or points already covered of the order. */
  tendered: number;
  /** Units of the order that no live delivery carries yet, and units carried by other live deliveries. */
  unplanned: number;
  carriedElsewhere: number;
  /** A way of receiving cash at the door has been chosen in the settings. */
  methodChosen: boolean;
  /** The delivery is already marked. */
  alreadyMarked: boolean;
}

/**
 * Why this delivery cannot be marked to be paid at the door, in words, or null when it can. The money has to be one clear amount in
 * one currency collected in one go, so the delivery must carry the whole order, by the shop's own rider, before it goes out.
 */
export function markProblem(f: MarkFacts): string | null {
  if (!f.methodChosen) return 'Choose how cash at the door is received (Delivery › Door payments) before marking a delivery.';
  if (f.alreadyMarked) return 'This delivery is already marked to be paid at the door.';
  if (f.method !== 'own_fleet') return 'Only a delivery carried by the shop\'s own riders can be paid at the door.';
  if (!['draft', 'released', 'picking', 'packed', 'ready'].includes(f.status)) return 'It can only be marked before it goes out.';
  if (f.orderStatus === 'cancelled' || f.orderStatus === 'refunded' || f.orderStatus === 'failed') return 'This order was cancelled or refunded.';
  if (f.orderPaymentMethod === 'on_account') return 'An order on account is paid on its invoice, not at the door.';
  if (f.orderPaymentStatus !== 'unpaid') return 'This order already has a payment on it, so it cannot be paid at the door.';
  if (f.tendered > 0) return 'Part of this order was paid with a gift card or points, so it cannot be paid at the door.';
  if (f.orderCurrency.toUpperCase() !== f.baseCurrency.toUpperCase()) return `Cash at the door is taken in ${f.baseCurrency} only.`;
  if (f.carriedElsewhere > 0 || f.unplanned > 0) return 'A delivery paid at the door must carry the whole order. Put everything on this one delivery, or collect the payment another way.';
  return null;
}

/** What is due at the door: the order's total, as exact money. */
export const doorAmount = (orderTotal: string | number): string => fromCents(toCents(orderTotal));

export type Collected = { ok: true } | { ok: false; error: string };

/** What the rider says they collected must be what is due, to the cent. Short or over is not recorded as a payment. */
export function collectedProblem(due: string | number, said: unknown): Collected {
  if (typeof said !== 'number' || !Number.isFinite(said) || said <= 0) return { ok: false, error: 'Say how much cash you collected.' };
  if (toCents(said) !== toCents(due)) {
    return { ok: false, error: `The amount due is KSh ${Number(due).toFixed(2)}. Collect exactly that. If the customer cannot pay it all, record that it could not be delivered.` };
  }
  return { ok: true };
}

export interface CustodyLine {
  kind: CustodyKind;
  /** Positive in the rider's custody (collected), negative out of it (handed in). Adjustments carry their own sign. */
  cents: number;
}

/** What a rider holds: collected less handed in, with adjustments. Never below nothing in what is shown, but the sum is kept honest. */
export const custodyBalance = (lines: readonly CustodyLine[]): number => lines.reduce((n, l) => n + l.cents, 0);

/** The sign a kind has on the custody: collecting adds, handing in takes away. */
export const custodySign = (kind: Exclude<CustodyKind, 'adjusted'>): 1 | -1 => (kind === 'collected' ? 1 : -1);

// ── Handing the cash in ──────────────────────────────────────────────────────────────────────────────────────────────

export const HAND_IN_STATUSES = ['pending_approval', 'posted', 'rejected'] as const;
export type HandInStatus = (typeof HAND_IN_STATUSES)[number];

export const HAND_IN_WORDS: Record<HandInStatus, string> = {
  pending_approval: 'Waiting for approval',
  posted: 'Handed in',
  rejected: 'Not accepted',
};

export type HandInKind = 'exact' | 'within_limit' | 'needs_approval';

export interface HandInCheck {
  expectedCents: number;
  countedCents: number;
  /** Counted less held: negative is short, positive is over. */
  diffCents: number;
  kind: HandInKind;
}

/**
 * What a hand-in comes to. The rider is expected to hand in all they hold. A difference of nothing posts at once; a difference within
 * the company's limit posts at once, with its reason and the account it is written to; a bigger one waits for a second person.
 */
export function handInCheck(expectedCents: number, countedCents: number, limitCents: number): HandInCheck {
  const diffCents = countedCents - expectedCents;
  let kind: HandInKind = 'needs_approval';
  if (diffCents === 0) kind = 'exact';
  else if (Math.abs(diffCents) <= limitCents) kind = 'within_limit';
  return { expectedCents, countedCents, diffCents, kind };
}

export interface HandInFacts {
  expectedCents: number;
  /** What was counted, as typed; checked for being a real amount. */
  counted: unknown;
  /** Notes on a difference, and where it is written. */
  note: string | null;
  hasVarianceAccount: boolean;
  /** Who is involved: the person recording, the witness, and the rider's own account. */
  recorderId: string;
  witnessId: string | null;
  riderUserId: string;
  /** The account the cash goes to is not the account riders' cash is held in. */
  sameAccount: boolean;
}

/** Why a hand-in cannot be recorded, in words, or null when it can; then the amount counted, in cents. */
export function handInProblem(f: HandInFacts, limitCents: number): { error: string } | { countedCents: number; check: HandInCheck } {
  if (f.expectedCents <= 0) return { error: 'This rider holds no cash to hand in.' };
  if (typeof f.counted !== 'number' || !Number.isFinite(f.counted) || f.counted < 0) return { error: 'Say how much cash was counted.' };
  const countedCents = toCents(f.counted);
  if (f.sameAccount) return { error: 'Choose the till or bank account the cash goes into, not the account riders\' cash is held in.' };
  if (f.witnessId === null) return { error: 'A second person must witness the count. Choose who.' };
  if (f.witnessId === f.recorderId) return { error: 'The witness cannot be the person recording the hand-in.' };
  if (f.witnessId === f.riderUserId) return { error: 'The witness cannot be the rider handing in the cash.' };
  const check = handInCheck(f.expectedCents, countedCents, limitCents);
  if (check.diffCents !== 0) {
    if (f.note === null || f.note.length < 5) return { error: `The count is ${check.diffCents < 0 ? 'short' : 'over'} by KSh ${fromCents(Math.abs(check.diffCents))}. Say why, in a few words.` };
    if (!f.hasVarianceAccount) return { error: 'Choose the account a difference is written to (Door payments › Differences) before recording one.' };
  }
  return { countedCents, check };
}

/** Whoever approves a hand-in with a difference is not whoever recorded it. */
export const approverProblem = (approverId: string, recorderId: string): string | null =>
  approverId === recorderId ? 'A hand-in with a difference must be approved by someone other than the person who recorded it.' : null;

export interface CustodyWrite {
  kind: 'handed_in' | 'adjusted';
  cents: number;
  note: string | null;
}

/** What goes into the rider's custody when a hand-in is posted: the cash handed in, and the difference, so what they hold comes to nothing. */
export function custodyWrites(check: HandInCheck, note: string | null): CustodyWrite[] {
  const writes: CustodyWrite[] = [{ kind: 'handed_in', cents: -check.countedCents, note: null }];
  if (check.diffCents !== 0) writes.push({ kind: 'adjusted', cents: check.diffCents, note: note ?? 'Difference at hand-in' });
  return writes;
}

export interface HandInLine {
  side: 'debit' | 'credit';
  account: 'destination' | 'custody' | 'variance';
  cents: number;
}

/**
 * The books' lines for a hand-in: the account riders' cash is held in is cleared of what the rider held; the till or bank takes what was
 * counted; a shortage is written to the difference account, and an excess comes from it. Always balanced.
 */
export function handInLines(check: HandInCheck): HandInLine[] {
  const lines: HandInLine[] = [
    { side: 'debit', account: 'destination', cents: check.countedCents },
    { side: 'credit', account: 'custody', cents: check.expectedCents },
  ];
  if (check.diffCents < 0) lines.push({ side: 'debit', account: 'variance', cents: -check.diffCents });
  if (check.diffCents > 0) lines.push({ side: 'credit', account: 'variance', cents: check.diffCents });
  return lines.filter((l) => l.cents > 0);
}

// ── M-Pesa at the door ───────────────────────────────────────────────────────────────────────────────────────────────

/** How many prompts the rider may send for one delivery: after that, cash, or the office. */
export const MAX_DOOR_PROMPTS = 3;
/** A prompt that has not been answered is left alone for this long before another can be sent. */
export const PROMPT_WAIT_SECONDS = 90;

const IN_FLIGHT = ['initiated', 'pending', 'awaiting_redirect'] as const;

export interface PromptFacts {
  runOnTheRoad: boolean;
  deliveryStatus: string;
  /** What the office marked to be collected, and what the order really has left to pay now. */
  doorAmount: string | null;
  amountDue: number;
  orderPaymentStatus: string;
  /** The number the prompt goes to, already read as a Kenyan mobile number; null when it is not one. */
  phone: string | null;
  promptsSent: number;
  lastAttempt: { status: string; ageSeconds: number } | null;
}

/** Why a prompt cannot be sent now, in words for the rider, or null when it can. */
export function promptProblem(f: PromptFacts): string | null {
  if (!f.runOnTheRoad) return 'This run is not on the road.';
  if (f.deliveryStatus !== 'out_for_delivery') return 'This stop is not out for delivery.';
  if (f.doorAmount === null) return 'This delivery is not to be paid at the door.';
  if (f.orderPaymentStatus === 'paid') return 'This order has already been paid.';
  if (toCents(f.amountDue) !== toCents(f.doorAmount)) return 'The amount due has changed since this delivery went out. Ask the office.';
  if (f.phone === null) return 'Type the number the customer will pay from, for example 0712 345 678.';
  if (f.promptsSent >= MAX_DOOR_PROMPTS) return `${String(MAX_DOOR_PROMPTS)} prompts have been sent for this delivery. Take the cash instead, or ask the office.`;
  if (f.lastAttempt !== null && (IN_FLIGHT as readonly string[]).includes(f.lastAttempt.status) && f.lastAttempt.ageSeconds < PROMPT_WAIT_SECONDS) {
    return 'A prompt was just sent. Wait for the customer to answer it, or for it to time out.';
  }
  return null;
}

export type PromptState = 'none' | 'waiting' | 'paid' | 'failed';

/** Where the M-Pesa prompt at this door stands: the order is paid, or the last prompt is still out, or it did not go through. */
export function promptState(orderPaid: boolean, last: { status: string } | null): PromptState {
  if (orderPaid) return 'paid';
  if (last === null) return 'none';
  if ((IN_FLIGHT as readonly string[]).includes(last.status)) return 'waiting';
  return last.status === 'successful' ? 'waiting' : 'failed';
}

export const PROMPT_FAILED_WORDS: Record<string, string> = {
  failed: 'The payment did not go through (the customer may have cancelled, or had too little in M-Pesa).',
  cancelled: 'The customer cancelled the payment.',
  expired: 'The prompt timed out before the customer answered.',
};
