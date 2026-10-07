/**
 * The business date a document belongs to, as `YYYY-MM-DD`, in the company's timezone.
 *
 * Numbering periods (year, month) follow this date, not the server clock: in UTC a document made
 * at 01:00 on 1 January in Nairobi would still be dated 31 December and fall into last year's
 * counter. The timezone will come from the country master once it exists; until then it is the
 * home market's.
 */
export const DEFAULT_BUSINESS_TIMEZONE = 'Africa/Nairobi';

export function businessDate(
  now: Date = new Date(),
  timeZone: string = DEFAULT_BUSINESS_TIMEZONE,
): string {
  // 'en-CA' formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}
