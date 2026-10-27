/** How a time and the time between two stages are shown, in words. Pure. */

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** "45 s", "3 min 20 s", "2 h 5 min", "1 d 3 h": the time that passed between two stages. Nothing for a negative or missing gap. */
export function durationWords(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '';
  if (ms < SECOND) return 'at once';
  if (ms < MINUTE) return `${String(Math.round(ms / SECOND))} s`;
  if (ms < HOUR) {
    const minutes = Math.floor(ms / MINUTE);
    const seconds = Math.round((ms % MINUTE) / SECOND);
    return seconds === 0 ? `${String(minutes)} min` : `${String(minutes)} min ${String(seconds)} s`;
  }
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR);
    const minutes = Math.round((ms % HOUR) / MINUTE);
    return minutes === 0 ? `${String(hours)} h` : `${String(hours)} h ${String(minutes)} min`;
  }
  const days = Math.floor(ms / DAY);
  const hours = Math.round((ms % DAY) / HOUR);
  return hours === 0 ? `${String(days)} d` : `${String(days)} d ${String(hours)} h`;
}

/** A stage time as people in Kenya read it (Nairobi time), with seconds so two stages a moment apart can be told apart. */
export function stageTime(iso: string): string {
  return new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
}

/** The same without the seconds, for the customer. */
export function stageTimeShort(iso: string): string {
  return new Date(iso).toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
}

export type StageTone = 'good' | 'bad' | 'neutral';

const TONES: Record<string, StageTone> = { failed: 'bad', cancelled: 'bad', succeeded: 'good' };

export const outcomeTone = (outcome: string): StageTone => TONES[outcome] ?? 'neutral';

/** Plain words for the reason codes a person is likely to see. Anything else is shown as written. */
export function reasonWords(code: string | null): string {
  if (code === null) return '';
  const known: Record<string, string> = {
    invalid_input: 'Details could not be read',
    rate_limited: 'Too many tries',
    quantity_limit: 'Quantity outside the limits',
    invalid_quantity: 'Quantity not valid for the unit',
    stock_short: 'Not enough stock',
    not_for_sale: 'Not for sale',
    not_found: 'Product not found',
    cannot_be_priced: 'Could not be priced',
    coupon_refused: 'Coupon refused',
    credit_limit: 'Over the credit limit',
    approval_needed: 'Needs approval',
    kit_error: 'Set contents problem',
    payment_start_failed: 'The payment could not be started',
    payment_failed: 'The payment did not go through',
    payout_returned: 'The refund payout came back',
    cancel_order: 'Cancelled when resolving a payment difference',
    force_match: 'Matched by hand',
  };
  return known[code] ?? code.replace(/_/g, ' ');
}
