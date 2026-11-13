import { straightLineKm, type GeoPoint } from './geo';

/** A run: a rider's trip with several deliveries, in an order. Pure rules; the service holds the lock and the database. */
export const RUN_STATUSES = ['planned', 'started', 'completed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const isRunStatus = (value: unknown): value is RunStatus => typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value);

export const RUN_STATUS_WORDS: Record<RunStatus, string> = { planned: 'Planned', started: 'On the road', completed: 'Completed', cancelled: 'Cancelled' };

export const RUN_ACTIONS = ['start', 'complete', 'cancel'] as const;
export type RunAction = (typeof RUN_ACTIONS)[number];
export const RUN_ACTION_WORDS: Record<RunAction, string> = { start: 'Start the run', complete: 'Close the run', cancel: 'Cancel the run' };

const NEXT: Record<RunStatus, Partial<Record<RunAction, RunStatus>>> = {
  planned: { start: 'started', cancel: 'cancelled' },
  started: { complete: 'completed' },
  completed: {},
  cancelled: {},
};

export const nextRunStatus = (from: RunStatus, action: RunAction): RunStatus | null => NEXT[from][action] ?? null;
export const runActionsFrom = (from: RunStatus): RunAction[] => RUN_ACTIONS.filter((a) => NEXT[from][a] !== undefined);
/** Stops can be added, removed and reordered only before the run goes out. */
export const isRunEditable = (status: RunStatus): boolean => status === 'planned';

/** Only a delivery that is ready, and not already on a run, can be put on one. */
export const canJoinRun = (deliveryStatus: string, onRun: boolean): boolean => deliveryStatus === 'ready' && !onRun;

/**
 * Whether a run can be closed: every delivery on it has been dealt with. One still out for delivery has no result yet, so the run
 * stays open until it has one (delivered, tried and failed, or returned).
 */
export const runCloseProblem = (stops: readonly { deliveryStatus: string }[]): string | null => {
  const open = stops.filter((s) => s.deliveryStatus === 'out_for_delivery').length;
  if (open === 0) return null;
  return `${String(open)} ${open === 1 ? 'delivery is' : 'deliveries are'} still out. Record how ${open === 1 ? 'it' : 'each'} went (delivered or not) before closing the run.`;
};

export interface StopPoint {
  id: string;
  point: GeoPoint | null;
}

/**
 * A suggested order for the stops: from the start, always the nearest one next. A stop with no map pin goes after the ones that have
 * one, in the order given. It is a suggestion; a person puts the stops in the order they choose, and a better route sits behind a
 * port later.
 */
export function nearestNext(start: GeoPoint | null, stops: readonly StopPoint[]): string[] {
  const placed = stops.filter((s): s is StopPoint & { point: GeoPoint } => s.point !== null);
  const unplaced = stops.filter((s) => s.point === null).map((s) => s.id);
  const order: string[] = [];
  const left = [...placed];
  let here: GeoPoint | undefined = start ?? left[0]?.point;
  if (here === undefined) return unplaced;
  while (left.length > 0) {
    const from: GeoPoint = here;
    let best = 0;
    let bestKm = Number.POSITIVE_INFINITY;
    left.forEach((s, i) => {
      const km = straightLineKm(from, s.point);
      if (km < bestKm) {
        bestKm = km;
        best = i;
      }
    });
    const [next] = left.splice(best, 1);
    if (next === undefined) break;
    order.push(next.id);
    here = next.point;
  }
  return [...order, ...unplaced];
}

export interface RunStopFacts {
  units: number;
  value: number;
  weightKg: number | null;
  volumeLitres: number | null;
}

export interface RunTotals {
  stops: number;
  units: number;
  value: number;
  /** Null when no product on the run has a weight; otherwise the weight of those that do, and how many stops lack one. */
  weightKg: number | null;
  stopsWithoutWeight: number;
  /** The same for the space goods take, in litres. */
  volumeLitres: number | null;
  stopsWithoutVolume: number;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

export function runTotals(stops: readonly RunStopFacts[]): RunTotals {
  const weighed = stops.filter((s) => s.weightKg !== null);
  const measured = stops.filter((s) => s.volumeLitres !== null);
  return {
    stops: stops.length,
    units: round3(stops.reduce((n, s) => n + s.units, 0)),
    value: Math.round(stops.reduce((n, s) => n + s.value, 0) * 100) / 100,
    weightKg: weighed.length === 0 ? null : round3(weighed.reduce((n, s) => n + (s.weightKg ?? 0), 0)),
    stopsWithoutWeight: stops.length - weighed.length,
    volumeLitres: measured.length === 0 ? null : round3(measured.reduce((n, s) => n + (s.volumeLitres ?? 0), 0)),
    stopsWithoutVolume: stops.length - measured.length,
  };
}

export const WAITING_FLAG_HOURS = 24;

/** How long a delivery has been ready and waiting, and whether that is long enough to flag. The clock is passed in. */
export function waitingSince(readyAt: Date | null, now: Date): { hours: number; late: boolean } | null {
  if (readyAt === null) return null;
  const hours = Math.max(0, Math.floor((now.getTime() - readyAt.getTime()) / 3_600_000));
  return { hours, late: hours >= WAITING_FLAG_HOURS };
}

/** The order a list of stop ids takes after moving one, or null if the id is not in it or the move goes nowhere. */
export function moveStop(ids: readonly string[], id: string, direction: 'up' | 'down'): string[] | null {
  const at = ids.indexOf(id);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  const [moved] = next.splice(at, 1);
  if (moved === undefined) return null;
  next.splice(to, 0, moved);
  return next;
}

/** Whether `ids` is exactly the stops of the run in some order (nothing missing, nothing added, nothing twice). */
export const isReordering = (current: readonly string[], ids: readonly string[]): boolean => current.length === ids.length && new Set(ids).size === ids.length && ids.every((id) => current.includes(id));
