/**
 * What the refund screen says about the M-Pesa attempts to pay a refund, and what a person may do about them. Pure.
 */
export interface PayoutAttempt {
  id: string;
  status: string;
  reference: string | null;
  failure: string | null;
  at: string;
}

export type PayoutState =
  | { kind: 'none' }
  | { kind: 'in_flight'; attempt: PayoutAttempt }
  | { kind: 'doubtful'; attempt: PayoutAttempt; canRecheck: boolean }
  | { kind: 'failed'; attempt: PayoutAttempt };

const IN_FLIGHT = ['queued', 'submitted', 'accepted', 'approved', 'pending_approval', 'created'];
const DOUBTFUL = ['in_doubt', 'timed_out'];
const FAILED = ['failed', 'rejected', 'cancelled'];

/** The newest attempt decides: a payout still on its way, held for a person, or finished without paying. Paid ones are not shown here. */
export function payoutState(attempts: readonly PayoutAttempt[]): PayoutState {
  const latest = [...attempts].sort((a, b) => b.at.localeCompare(a.at)).find((a) => a.status !== 'succeeded');
  if (latest === undefined) return { kind: 'none' };
  if (IN_FLIGHT.includes(latest.status)) return { kind: 'in_flight', attempt: latest };
  if (DOUBTFUL.includes(latest.status)) return { kind: 'doubtful', attempt: latest, canRecheck: latest.reference !== null && latest.reference !== '' };
  return FAILED.includes(latest.status) ? { kind: 'failed', attempt: latest } : { kind: 'none' };
}

/** The words for the person who has to decide what happened to a payout that could not be confirmed. */
export function doubtfulAdvice(canRecheck: boolean): string {
  return canRecheck
    ? 'Safaricom gave a receipt for this payment but its own record could not be matched to it. Check it again, or look at the M-Pesa statement and close the attempt with what you find.'
    : 'No answer came from Safaricom for this payment. Look at the M-Pesa statement for it and close the attempt with what you find; do not send it again until you have.';
}

/** What closing the attempt leads to next. */
export const closedNext = (moneyLeft: boolean): string =>
  moneyLeft ? 'Record the payment by hand with the receipt from the statement.' : 'The refund can be sent again.';

export const CLOSE_REASON_MIN = 10;
export const reasonLongEnough = (reason: string): boolean => reason.trim().length >= CLOSE_REASON_MIN;

/** The colour of one attempt in the list: paid, held for a person, failed, or on its way. */
export function attemptTone(status: string): 'green' | 'amber' | 'red' | 'sky' {
  if (status === 'succeeded') return 'green';
  if (DOUBTFUL.includes(status)) return 'amber';
  return status === 'failed' ? 'red' : 'sky';
}
