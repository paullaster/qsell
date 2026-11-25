/**
 * Running a van day (docs/architecture/van-sales.md §7, §10): sending it out with a counted float, and the visits a rep makes. Pure: no clock, no
 * database; the server reads with this same code and the phone shows the same words.
 */
import { MAX_MONEY } from '@/lib/decimal';
import { readGeoPoint, straightLineKm, type GeoPoint } from '@/lib/geo';
import { isRecord } from '@/lib/values';
import { REASON_LIMIT } from './people';
import type { DayStatus, VisitStatus } from './days';
import type { RouteMode, VanSalesSettings } from './settings';

/** The cash the rep counts into the van's till at the start: nothing is a fair answer (a van that starts with no float). */
export function readFloat(raw: unknown): { ok: true; amount: number } | { ok: false; error: string } {
  const typed = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN;
  const n = typeof raw === 'number' ? raw : typed;
  if (!Number.isFinite(n) || n < 0 || n > MAX_MONEY) return { ok: false, error: 'Give the cash counted into the van\'s till, in shillings: nothing, or more.' };
  return { ok: true, amount: Math.round(n * 100) / 100 };
}

/** Where the phone says it is: none, a real place, or a refusal in words. */
export function readPosition(raw: unknown): { ok: true; point: GeoPoint | null } | { ok: false; error: string } {
  if (raw === undefined || raw === null) return { ok: true, point: null };
  if (!isRecord(raw)) return { ok: false, error: 'The position could not be read.' };
  const read = readGeoPoint(raw.latitude, raw.longitude);
  return read.ok ? { ok: true, point: read.point } : read;
}

/** The metres between two places, rounded. */
export const metresBetween = (a: GeoPoint, b: GeoPoint): number => Math.round(straightLineKm(a, b) * 1000);

/**
 * Whether a rep may start a visit from where they are. The company either records the distance and never stops a visit, or requires the rep to
 * be near the customer. A customer with no map pin cannot be checked, so the visit starts and the distance is not known.
 */
export function arrivalProblem(rule: Pick<VanSalesSettings, 'position' | 'nearMetres'>, customer: string, position: GeoPoint | null, distanceM: number | null): string | null {
  if (rule.position !== 'require') return null;
  if (position === null) return `The company needs your position to start a visit. Allow the location on your phone and try again.`;
  if (distanceM === null) return null;
  return distanceM > rule.nearMetres ? `You are ${String(distanceM)} m from ${customer}. Get within ${String(rule.nearMetres)} m to start the visit.` : null;
}

/** What a visit can move to. A visit that is done, skipped or found shut is finished. */
export const VISIT_MOVES: Record<VisitStatus, readonly VisitStatus[]> = {
  planned: ['arrived', 'skipped', 'closed_shop'],
  arrived: ['done', 'closed_shop'],
  done: [],
  skipped: [],
  closed_shop: [],
};
export const canMoveVisit = (from: VisitStatus, to: VisitStatus): boolean => VISIT_MOVES[from].includes(to);

/** How a visit ends, where nothing was sold; a visit with sales ends as sold. */
export const FINISH_OUTCOMES = ['no_sale'] as const;
export type FinishOutcome = (typeof FINISH_OUTCOMES)[number];

export interface FinishInput {
  outcome: FinishOutcome;
  reason: string | null;
}

/** A reason in the rep's own words, 3 to 300 characters. */
export function readWhy(raw: unknown): { ok: true; reason: string } | { ok: false; error: string } {
  const reason = typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < REASON_LIMIT.min || reason.length > REASON_LIMIT.max) return { ok: false, error: `Say why, in ${String(REASON_LIMIT.min)} to ${String(REASON_LIMIT.max)} characters.` };
  return { ok: true, reason };
}

/** Reads how a visit ends: no sale needs the reason. */
export function readFinish(raw: unknown): { ok: true; finish: FinishInput } | { ok: false; error: string } {
  const r = isRecord(raw) ? raw : {};
  const outcome = FINISH_OUTCOMES.find((o) => o === r.outcome);
  if (outcome === undefined) return { ok: false, error: 'Say how the visit ended.' };
  const why = readWhy(r.reason);
  if (!why.ok) return { ok: false, error: `A visit with no sale needs a reason. ${why.error}` };
  return { ok: true, finish: { outcome, reason: why.reason } };
}

export interface OutFacts {
  status: DayStatus;
  mode: RouteMode;
  /** The day's load has been signed for. */
  loadSigned: boolean;
}

/** Why a day cannot go out yet, in words; null when it can. A day that sells from a van goes out after its load is signed for. */
export function goOutProblem(day: OutFacts): string | null {
  if (day.status === 'out') return 'This day is already out.';
  if (day.status !== 'planned' && day.status !== 'loading') return 'This day has already run its course.';
  if (day.mode === 'pre_sell') return null;
  if (!day.loadSigned) return 'The van has no stock yet. Make up the load, send it and sign for it before the day goes out.';
  return null;
}
