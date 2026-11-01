import type { Surcharge } from './types';

export interface LocalClock {
  /** 0 is Sunday. */
  dayOfWeek: number;
  minuteOfDay: number;
  /** "MM-DD" */
  monthDay: string;
}

const DAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The day, the minute of the day and the date at this moment in a time zone. Throws a RangeError for a time zone that does not exist. */
export function localClock(at: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', month: '2-digit', day: '2-digit', hourCycle: 'h23' }).formatToParts(at);
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const weekday = get('weekday');
  const dayOfWeek = DAYS[weekday];
  if (dayOfWeek === undefined) throw new RangeError(`Unknown weekday "${weekday}".`);
  return { dayOfWeek, minuteOfDay: Number(get('hour')) * 60 + Number(get('minute')), monthDay: `${get('month')}-${get('day')}` };
}

/** Is this "MM-DD" inside the range? A range whose start is after its end crosses the new year (December to February). */
export function inDateRange(monthDay: string, from: string, to: string): boolean {
  if (from <= to) return monthDay >= from && monthDay <= to;
  return monthDay >= from || monthDay <= to;
}

/** Does the time rule hold at this local moment? A window that crosses midnight belongs to the day it began. */
export function ruleHolds(rule: Pick<Surcharge, 'days' | 'fromMinute' | 'toMinute' | 'dateFrom' | 'dateTo'>, clock: LocalClock): boolean {
  if (rule.dateFrom !== null && rule.dateTo !== null && !inDateRange(clock.monthDay, rule.dateFrom, rule.dateTo)) return false;
  let day = clock.dayOfWeek;
  if (rule.fromMinute !== null && rule.toMinute !== null) {
    const { fromMinute: from, toMinute: to } = rule;
    if (from <= to) {
      if (clock.minuteOfDay < from || clock.minuteOfDay >= to) return false;
    } else if (clock.minuteOfDay >= from) {
      // the evening part: it began today
    } else if (clock.minuteOfDay < to) {
      day = (day + 6) % 7;
    } else {
      return false;
    }
  }
  return rule.days === null || rule.days.includes(day);
}

/** The offset of a time zone from UTC at a moment, in minutes. Zones less than 12 hours from UTC. */
function offsetMinutes(at: Date, timeZone: string): number {
  const local = localClock(at, timeZone).minuteOfDay;
  const utc = at.getUTCHours() * 60 + at.getUTCMinutes();
  return ((local - utc + 1440 + 720) % 1440) - 720;
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is this a calendar date written as YYYY-MM-DD? */
export const isDateOnly = (text: string): boolean => {
  const m = DATE_ONLY.exec(text);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
};

/** The moment a calendar day (YYYY-MM-DD) begins in a time zone. */
export function startOfLocalDay(day: string, timeZone: string): Date {
  const m = DATE_ONLY.exec(day);
  if (m === null) throw new RangeError(`"${day}" is not a date.`);
  const utcMidnight = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  // The offset can differ between midnight UTC and local midnight (daylight saving), so settle it in two passes.
  const first = new Date(utcMidnight - offsetMinutes(new Date(utcMidnight), timeZone) * 60_000);
  return new Date(utcMidnight - offsetMinutes(first, timeZone) * 60_000);
}

/** The calendar day after YYYY-MM-DD. */
export function nextDay(day: string): string {
  const m = DATE_ONLY.exec(day);
  if (m === null) throw new RangeError(`"${day}" is not a date.`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + 1)).toISOString().slice(0, 10);
}
