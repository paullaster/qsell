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
