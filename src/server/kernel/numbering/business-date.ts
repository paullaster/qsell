import { BUILT_IN_TIME_ZONE, isValidTimeZone } from '@/lib/business-timezone';

/**
 * The business date a document belongs to, as `YYYY-MM-DD`, in the company's timezone.
 *
 * Numbering periods (year, month) follow this date, not the server clock: in UTC a document made
 * at 01:00 on 1 January in Nairobi would still be dated 31 December and fall into last year's
 * counter.
 *
 * The timezone is a company setting kept in the database (Settings, Business time zone) and changed only by someone with the
 * `timezone:manage` permission. This process follows it: whenever the company row is read or changed (every request, every
 * background job) it tells this module which zone the company chose, and until it has been read the built-in zone stands in. Nothing
 * here is an environment value.
 */
let current: string = BUILT_IN_TIME_ZONE;

/** The business's time zone now, as the company chose it. */
export function businessTimeZone(): string {
  return current;
}

/** Called with the zone on the company row whenever that row is read or changed. A value that is not a usable zone is ignored, so a bad row never breaks every date. */
export function followBusinessTimeZone(timeZone: unknown): void {
  if (typeof timeZone === 'string' && isValidTimeZone(timeZone)) current = timeZone;
}

export function businessDate(
  now: Date = new Date(),
  timeZone: string = businessTimeZone(),
): string {
  // 'en-CA' formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** A stored instant written in the business timezone, so a screen can show it without reading the clock. */
export function formatBusinessTime(instant: Date, timeZone: string = businessTimeZone()): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(instant);
}
