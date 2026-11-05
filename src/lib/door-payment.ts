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
