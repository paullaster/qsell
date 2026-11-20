/**
 * The rules of a till shift: counting the cash, what the till should hold, the difference when it is closed and when a difference
 * needs a supervisor. Pure (docs/architecture/selling-documents.md section 4.5).
 */

/** The notes and coins of the Kenyan shilling a drawer is counted in, largest first. */
export const KES_DENOMINATIONS = [1000, 500, 200, 100, 50, 20, 10, 5, 1] as const;

export interface Counted {
  value: number;
  count: number;
}

export const MAX_COUNT = 100_000;
export const MAX_CASH = 1_000_000_000;

const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;
const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What counted notes and coins come to. */
export const totalOf = (counted: readonly Counted[]): number => round2(counted.reduce((sum, c) => sum + c.value * c.count, 0));

export type ParsedCount = { ok: true; counted: Counted[]; total: number } | { ok: false; error: string };

/**
 * Reads the cash a person counted: either the notes and coins (`counted`: value and how many of each, only real denominations, each
 * once) or, for a quick count, just a `total`. A count is never negative and never more than a billion.
 */
export function parseCount(raw: unknown, what: string): ParsedCount {
  if (!isRecord(raw)) return { ok: false, error: `Count the ${what}.` };
  if (Array.isArray(raw.counted)) {
    const seen = new Set<number>();
    const counted: Counted[] = [];
    for (const entry of raw.counted) {
      if (!isRecord(entry)) return { ok: false, error: `The count of the ${what} could not be read.` };
      const { value, count } = entry;
      if (typeof value !== 'number' || !(KES_DENOMINATIONS as readonly number[]).includes(value) || seen.has(value)) return { ok: false, error: `The count of the ${what} has a note or coin that is not one.` };
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0 || count > MAX_COUNT) return { ok: false, error: `Each count of the ${what} must be a whole number from 0 to ${String(MAX_COUNT)}.` };
      seen.add(value);
      if (count > 0) counted.push({ value, count });
    }
    counted.sort((a, b) => b.value - a.value);
    const total = totalOf(counted);
    return total > MAX_CASH ? { ok: false, error: `The ${what} is more than can be counted here.` } : { ok: true, counted, total };
  }
  const total = raw.total;
  if (typeof total !== 'number' || !Number.isFinite(total) || total < 0 || total > MAX_CASH) return { ok: false, error: `Give the total of the ${what} as an amount of nothing or more.` };
  return { ok: true, counted: [], total: round2(total) };
}

/** An amount of money entered for a movement: more than nothing, at most two decimals, not absurd. */
export function parseAmount(raw: unknown): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0 || raw > MAX_CASH) return null;
  const rounded = round2(raw);
  return Math.abs(rounded - raw) < 1e-9 ? rounded : null;
}

export interface ShiftFigures {
  openingFloat: number;
  paidIn: number;
  paidOut: number;
  /** Cash taken for sales in the shift (from the cash sales recorded against it). */
  cashSales: number;
  /** Cash handed back to customers at the till for returned sales (left out where there are none). */
  cashRefunds?: number;
}

/** What the till should hold now: the float, plus cash sales and cash put in, less cash taken out and cash refunded to customers. */
export const expectedCash = (f: ShiftFigures): number => round2(f.openingFloat + f.cashSales + f.paidIn - f.paidOut - (f.cashRefunds ?? 0));

/** The difference at the close: what was counted less what the till should hold (negative is short). */
export const varianceOf = (declared: number, expected: number): number => round2(declared - expected);

export interface Tolerance {
  /** A difference of up to this many shillings is within tolerance. */
  amount: number;
  /** Or up to this percent of what the till should hold. */
  percent: number;
}

export const DEFAULT_TOLERANCE: Tolerance = { amount: 100, percent: 1 };

export type VarianceKind = 'none' | 'within' | 'beyond';

/** No difference; a difference within the company's tolerance (either the amount or the percent is enough); or one beyond it. */
export function varianceKind(variance: number, expected: number, tolerance: Tolerance): VarianceKind {
  const size = Math.abs(variance);
  if (size < 0.005) return 'none';
  return size <= tolerance.amount + 1e-9 || size <= (Math.max(0, expected) * tolerance.percent) / 100 + 1e-9 ? 'within' : 'beyond';
}

export const REASON_MIN = 3;
export const REASON_MAX = 200;

/** What happens to a difference beyond the allowance: a supervisor closes the shift on the spot, or the close goes to the approval queue. */
export type SupervisorClose = 'direct' | 'approval';
export const SUPERVISOR_CLOSE_MODES: readonly SupervisorClose[] = ['direct', 'approval'];
export const isSupervisorClose = (value: unknown): value is SupervisorClose => value === 'direct' || value === 'approval';

/** `close` finishes the shift now; `approval` sends the count to the approval queue and holds the shift until it is decided. */
export type CloseCheck = { ok: true; kind: VarianceKind; route: 'close' | 'approval' } | { ok: false; error: string };

/**
 * Whether a shift can be closed with this difference by this person, and how. A difference needs a reason in words. One beyond the
 * allowance is closed by a supervisor on the spot (direct), or, when the company chose the approval queue, goes to it: a supervisor
 * still closes another person's shift on the spot (they are the second pair of eyes), but a shift counted by its own holder, supervisor
 * or not, is approved by someone else.
 */
export function checkClose(input: { variance: number; expected: number; reason: string; tolerance: Tolerance; supervisor: boolean; mode?: SupervisorClose; ownShift?: boolean }): CloseCheck {
  const kind = varianceKind(input.variance, input.expected, input.tolerance);
  const reason = input.reason.trim();
  if (kind !== 'none' && (reason.length < REASON_MIN || reason.length > REASON_MAX)) return { ok: false, error: `There is a difference of ${String(input.variance)}: say why, in ${String(REASON_MIN)} to ${String(REASON_MAX)} characters.` };
  if (kind !== 'beyond') return { ok: true, kind, route: 'close' };
  if ((input.mode ?? 'direct') === 'approval') return input.supervisor && input.ownShift === false ? { ok: true, kind, route: 'close' } : { ok: true, kind, route: 'approval' };
  if (!input.supervisor) return { ok: false, error: 'The difference is more than the company allows a till to be out by. A supervisor has to close this shift.' };
  return { ok: true, kind, route: 'close' };
}

export const toleranceProblem = (t: Tolerance): string | null => {
  if (!Number.isFinite(t.amount) || t.amount < 0 || t.amount > 1_000_000) return 'The allowed difference must be an amount from 0 to 1,000,000.';
  if (!Number.isFinite(t.percent) || t.percent < 0 || t.percent > 100) return 'The allowed percent must be from 0 to 100.';
  return null;
};
