/**
 * How well delivery is doing: rates and averages for the performance screen. Pure rules; the database counts, these say what the
 * counts mean (and what to show when there is nothing to divide by).
 */

/** A share as a percentage with one decimal ("93.3"), or null when there is nothing to take a share of. */
export function ratePercent(part: number, whole: number): number | null {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.round((Math.min(Math.max(part, 0), whole) / whole) * 1000) / 10;
}

/** The average of a total over a count, in whole minutes, or null with no count. */
export function averageMinutes(totalMinutes: number, count: number): number | null {
  if (!Number.isFinite(totalMinutes) || !Number.isFinite(count) || count <= 0) return null;
  return Math.round(totalMinutes / count);
}

/** A rate as it is written on the screen: "93.3%", or the words given (by default, nothing was promised) with nothing to measure. */
export const rateWords = (rate: number | null, none = 'None promised'): string => (rate === null ? none : `${String(rate)}%`);

/** Minutes as a short length of time ("45 min", "3 h 20 min", "2 days 4 h"), or a dash. */
export function durationWords(minutes: number | null): string {
  if (minutes === null) return '-';
  const m = Math.max(0, Math.round(minutes));
  if (m < 60) return `${String(m)} min`;
  const days = Math.floor(m / 1440);
  const hours = Math.floor((m % 1440) / 60);
  const rest = m % 60;
  if (days > 0) return `${String(days)} ${days === 1 ? 'day' : 'days'}${hours > 0 ? ` ${String(hours)} h` : ''}`;
  return `${String(hours)} h${rest > 0 ? ` ${String(rest)} min` : ''}`;
}

/** How a slot's day-by-day room was used: the share of the places offered that were booked, or null when none were offered. */
export const fillPercent = (booked: number, offered: number): number | null => ratePercent(booked, offered);

/** Colour of a rate: a company wants to see at a glance which are poor. Below 80% is poor, below 95% needs watching. */
export function rateTone(rate: number | null): 'good' | 'watch' | 'poor' | 'none' {
  if (rate === null) return 'none';
  if (rate >= 95) return 'good';
  if (rate >= 80) return 'watch';
  return 'poor';
}
