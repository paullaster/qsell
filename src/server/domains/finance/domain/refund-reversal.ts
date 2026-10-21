/**
 * When a refund can be paid by reversing the customer's own M-Pesa payment instead of sending new money. A reversal gives the
 * money back to whoever paid, whole and exactly; that is its strength (it cannot go to another phone) and its limit. Pure.
 */

export interface OriginalPayment {
  /** The M-Pesa code of the customer's payment. */
  transactionId: string;
  amountCents: number;
  providerId: string;
  /** The paybill or till that received it. */
  methodId: string | null;
}

export interface ReversalFacts {
  status: string;
  detailsChanged: boolean;
  amountCents: number;
  /** The payment method the refund is to be paid through. */
  method: { kind: string; providerId: string | null; refundable: boolean };
  /** The customer's payment this refund comes out of, when one can be found. */
  original: OriginalPayment | null;
  /** A reversal of that payment is already under way or done. */
  alreadyReversed: boolean;
}

export type ReversalVerdict =
  { ok: true; original: OriginalPayment } | { ok: false; reason: string };

/** Whether the refund can be paid by reversing the customer's payment, and if not, why not, in words. */
export function decideReversal(f: ReversalFacts): ReversalVerdict {
  if (f.status !== 'approved')
    return {
      ok: false,
      reason: `Only an approved refund can be paid; this one is ${f.status.replace('_', ' ')}.`,
    };
  if (f.original === null)
    return {
      ok: false,
      reason:
        "No single M-Pesa payment of the customer's could be found for this refund, so there is nothing to reverse. Pay it another way.",
    };
  if (f.alreadyReversed)
    return {
      ok: false,
      reason:
        'That payment has already been reversed, or a reversal of it is waiting for an answer.',
    };
  if (f.method.kind !== 'mobile_money' || !f.method.refundable || f.method.providerId === null)
    return { ok: false, reason: 'This refund is not set to be paid through M-Pesa.' };
  if (f.method.providerId !== f.original.providerId)
    return {
      ok: false,
      reason:
        "The customer paid through a different M-Pesa connection than this refund's payment method uses.",
    };
  if (f.detailsChanged)
    return {
      ok: false,
      reason:
        "This refund is to be paid somewhere other than where the customer's record says. A reversal always goes back to whoever paid, so it cannot be used.",
    };
  if (f.amountCents !== f.original.amountCents)
    return {
      ok: false,
      reason:
        "A reversal gives back the customer's whole payment. This refund is for a different amount, so pay it another way.",
    };
  if (f.amountCents % 100 !== 0) return { ok: false, reason: 'M-Pesa moves whole shillings only.' };
  return { ok: true, original: f.original };
}
