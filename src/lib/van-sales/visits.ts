/**
 * Which customers a route visits on a day (docs/architecture/van-sales.md §4.2, §6.1). A stop has the weekdays it is visited on (a mask,
 * Monday is the lowest bit) and how often (every 1, 2 or 4 weeks, counted from the week it starts). Days are business dates written
 * `YYYY-MM-DD`, so nothing here reads a clock or depends on a time zone.
 */

export const WEEKDAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;
export const EVERY_WEEKS = [1, 2, 4] as const;
export type EveryWeeks = (typeof EVERY_WEEKS)[number];
const ALL_DAYS = 0b1111111;
const DAY = 86_400_000;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Days since 1970-01-01 of a business date, or null when it is not a real date. */
export function dayNumber(date: string): number | null {
  const m = DATE.exec(date);
  if (m === null) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const t = Date.UTC(y, mo - 1, d);
  const back = new Date(t);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null;
  return Math.round(t / DAY);
}

/** 0 for Monday up to 6 for Sunday. */
export function weekdayIndex(day: number): number {
  // 1970-01-01 was a Thursday (index 3).
  return (((day + 3) % 7) + 7) % 7;
}

export const maskOf = (weekdays: readonly number[]): number => weekdays.reduce((mask, d) => (d >= 0 && d <= 6 && Number.isInteger(d) ? mask | (1 << d) : mask), 0);
export const weekdaysOf = (mask: number): number[] => WEEKDAY_NAMES.map((_, i) => i).filter((i) => (mask & (1 << i)) !== 0);
export const weekdayWords = (mask: number): string => {
  const days = weekdaysOf(mask);
  if (days.length === 0) return 'No day';
  if (days.length === 7) return 'Every day';
  return days.map((i) => (WEEKDAY_NAMES[i] ?? '').slice(0, 3)).join(', ');
};

export const readEvery = (value: unknown): EveryWeeks | null => (EVERY_WEEKS.find((e) => e === value) ?? null);

/** Why a stop's days or frequency are not allowed; null when they are. */
export function visitPlanProblem(mask: unknown, every: unknown, anchor: unknown): string | null {
  if (typeof mask !== 'number' || !Number.isInteger(mask) || mask < 1 || mask > ALL_DAYS) return 'Choose at least one day of the week to visit.';
  if (readEvery(every) === null) return 'Choose how often to visit: every week, every 2 weeks or every 4 weeks.';
  if (typeof anchor !== 'string' || dayNumber(anchor) === null) return 'Give the date the visits start from.';
  return null;
}

export interface Stop {
  customerId: string;
  sequence: number;
  visitDays: number;
  every: EveryWeeks;
  /** The first day of the cycle: a date in the first week the stop is visited. */
  anchor: string;
  active: boolean;
}

const mondayOf = (day: number): number => day - weekdayIndex(day);

/** Whether this stop is to be visited on this day. */
export function isDue(stop: Stop, date: string): boolean {
  const day = dayNumber(date);
  const anchor = dayNumber(stop.anchor);
  if (day === null || anchor === null || !stop.active || day < anchor) return false;
  if ((stop.visitDays & (1 << weekdayIndex(day))) === 0) return false;
  const weeks = (mondayOf(day) - mondayOf(anchor)) / 7;
  return weeks % stop.every === 0;
}

/** The stops to visit on a day, in route order. */
export const dueStops = <T extends Stop>(stops: readonly T[], date: string): T[] => stops.filter((s) => isDue(s, date)).sort((a, b) => a.sequence - b.sequence);

/**
 * A customer is overdue when more than one full cycle has passed since the last visit (or since the stop began, if never visited) and
 * they are not due today. A stop that has not started yet is never overdue.
 */
export function isOverdue(stop: Stop, date: string, lastVisit: string | null): boolean {
  const day = dayNumber(date);
  const anchor = dayNumber(stop.anchor);
  if (day === null || anchor === null || !stop.active || day < anchor || isDue(stop, date)) return false;
  const since = lastVisit === null ? anchor : (dayNumber(lastVisit) ?? anchor);
  return day - since > stop.every * 7;
}
