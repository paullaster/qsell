/**
 * A van day (docs/architecture/van-sales.md §4.3, §7): one rep's one outing on one route on one date. Its life is a short list of states
 * with a fixed set of moves between them; this is the whole of it, so every slice adds a step without changing the shape. Pure: no clock
 * (the business date is passed in), no database.
 */
import { isRecord } from '@/lib/values';
import { dayNumber } from './visits';
import { isId } from './people';
import { modesNeeded, type RouteMode } from './settings';

export const DAY_STATUSES = ['planned', 'loading', 'out', 'returning', 'reconciling', 'closed', 'cancelled'] as const;
export type DayStatus = (typeof DAY_STATUSES)[number];

export const DAY_STATUS_WORDS: Record<DayStatus, string> = {
  planned: 'Planned',
  loading: 'Being loaded',
  out: 'Out on the route',
  returning: 'Back at the depot',
  reconciling: 'Being counted',
  closed: 'Closed',
  cancelled: 'Cancelled',
};

/** What each state can move to. A day is cancelled only before it goes out; once out it can only run its course. */
export const DAY_MOVES: Record<DayStatus, readonly DayStatus[]> = {
  // A day that only takes orders has nothing to load and goes straight out; a day with a van goes out after loading (the service checks).
  planned: ['loading', 'out', 'cancelled'],
  loading: ['out', 'cancelled'],
  out: ['returning'],
  returning: ['reconciling'],
  reconciling: ['closed'],
  closed: [],
  cancelled: [],
};

/** A day is open until it is closed or cancelled: it holds its rep and its van. */
export const isOpenDay = (status: DayStatus): boolean => status !== 'closed' && status !== 'cancelled';
export const canMoveDay = (from: DayStatus, to: DayStatus): boolean => DAY_MOVES[from].includes(to);

/** The visit list may be arranged while the day is still being got ready. */
export const canArrangeVisits = (status: DayStatus): boolean => status === 'planned' || status === 'loading';

export const readDayStatus = (value: unknown): DayStatus | null => DAY_STATUSES.find((s) => s === value) ?? null;

export const VISIT_STATUSES = ['planned', 'arrived', 'done', 'skipped', 'closed_shop'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
/** A visit's state from what is stored (anything unknown is a visit still to make). */
export const readVisitStatus = (value: string): VisitStatus => VISIT_STATUSES.find((s) => s === value) ?? 'planned';

/** How a finished visit is told to the rep who tries to change it. */
export const VISIT_OVER_WORDS: Partial<Record<VisitStatus, string>> = { done: 'finished', skipped: 'skipped', closed_shop: 'marked shut' };

export const VISIT_STATUS_WORDS: Record<VisitStatus, string> = { planned: 'To visit', arrived: 'At the customer', done: 'Done', skipped: 'Skipped', closed_shop: 'Shop closed' };

/** The things that happen to a day, in the words the history shows. */
export const DAY_EVENT_WORDS: Record<string, string> = {
  'day.planned': 'The day was planned',
  'day.cancelled': 'The day was cancelled',
  'day.visit_added': 'A customer was added to the visits',
  'day.visit_removed': 'A customer was taken off the visits',
  'day.visits_ordered': 'The visits were put in a new order',
  'day.loading': 'Loading began',
  'day.load_created': 'A load was made up',
  'day.load_approved': 'The load was approved',
  'day.load_shipped': 'The load left the warehouse',
  'day.load_signed': 'The load was signed for',
  'day.load_cancelled': 'The load was called off',
  'day.out': 'The day went out on the route',
  'day.visit_added_on_route': 'The rep added a customer on the road',
  'visit.arrived': 'The rep arrived at a customer',
  'visit.done': 'A visit was finished',
  'visit.skipped': 'A visit was skipped',
  'visit.closed_shop': 'The shop was found closed',
};

/** The modes a rep lacks for a route, in words; empty when the rep does everything the route needs. */
export function modesLacking(routeMode: RouteMode, repModes: readonly string[]): string[] {
  return modesNeeded(routeMode)
    .map((m) => (m === 'vanSell' ? 'van_sell' : 'pre_sell'))
    .filter((m) => !repModes.includes(m))
    .map((m) => (m === 'van_sell' ? 'van sell' : 'pre-sell'));
}

export interface PlanInput {
  routeId: string;
  date: string;
  repId: string | null;
  vanId: string | null;
}

export type PlanRead = { ok: true; plan: PlanInput } | { ok: false; error: string };

/** Reads a request to plan a day. A day is planned for today or a later date, never a day gone by. */
export function readPlan(raw: unknown, today: string): PlanRead {
  if (!isRecord(raw)) return { ok: false, error: 'The day could not be read.' };
  if (!isId(raw.routeId)) return { ok: false, error: 'Choose the route from the list.' };
  const day = typeof raw.date === 'string' ? dayNumber(raw.date) : null;
  const now = dayNumber(today);
  if (day === null || typeof raw.date !== 'string') return { ok: false, error: 'Give a real date for the day, such as 2026-11-30.' };
  if (now !== null && day < now) return { ok: false, error: 'A day cannot be planned for a date that has passed. Choose today or a later date.' };
  const optional = (value: unknown): string | null | undefined => {
    if (value === undefined || value === null || value === '') return null;
    return isId(value) ? value : undefined;
  };
  const repId = optional(raw.repId);
  const vanId = optional(raw.vanId);
  if (repId === undefined) return { ok: false, error: 'Choose a sales rep from the list, or leave it empty to use the route\'s usual rep.' };
  if (vanId === undefined) return { ok: false, error: 'Choose a van from the list, or leave it empty to use the route\'s usual van.' };
  return { ok: true, plan: { routeId: raw.routeId, date: raw.date, repId, vanId } };
}
