/** Dates the vendor rules depend on. Pure: the clock is always passed in. */

const DAY_MS = 86_400_000;

/**
 * The moment `days` working days (Monday to Friday) after `from`, at the same time of day. Public holidays are not known here;
 * the cool-off is a safety delay, so a holiday only makes it a little longer in practice.
 */
export function addBusinessDays(from: Date, days: number): Date {
  const out = new Date(from.getTime());
  let left = Math.max(0, Math.floor(days));
  while (left > 0) {
    out.setTime(out.getTime() + DAY_MS);
    const weekday = out.getUTCDay();
    if (weekday !== 0 && weekday !== 6) left -= 1;
  }
  return out;
}

/** Whole days from `today` to `expires` (both `YYYY-MM-DD`); negative once the day has passed. */
export function daysUntil(today: string, expires: string): number {
  return Math.round((Date.parse(`${expires}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

/**
 * The reminder to send now, or null. `thresholds` are days before expiry (for example 30, 7, 0). One is due when the document
 * is within it and it has not been sent: the nearest threshold already reached, and only if it is closer than the last one sent,
 * so a document is reminded once at each threshold even if the job missed a day.
 */
export function reminderDue(daysLeft: number, thresholds: readonly number[], lastSent: number | null): number | null {
  if (daysLeft < 0) return null;
  const reached = thresholds.filter((t) => daysLeft <= t).sort((a, b) => a - b)[0];
  if (reached === undefined) return null;
  return lastSent === null || reached < lastSent ? reached : null;
}
