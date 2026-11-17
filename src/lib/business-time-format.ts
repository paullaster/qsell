/** How a stored instant is written for people, in the business's time zone (never the server's or the browser's). Pure: the zone is always given. */

/** An instant as the screens receive it: the ISO text from the server, or a date already made from it. */
export type Instant = string | number | Date;

/** "18 Oct 2026, 17:00" style: the date and the time of an instant. */
export const whenIn = (iso: Instant, timeZone: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone });

/** The same, or nothing when there is no time to write (an operation that has not run, an empty field). */
export const whenOrBlank = (iso: Instant | null | undefined, timeZone: string): string => (iso === null || iso === undefined || iso === '' ? '' : whenIn(iso, timeZone));

/** "18 Oct 2026": the date an instant falls on in the business's time zone (a plain stored day goes through `dayOf`, never this: it has no instant). */
export const dateIn = (iso: Instant, timeZone: string): string => new Date(iso).toLocaleDateString('en-GB', { dateStyle: 'medium', timeZone });

/** The date written out for a plain day (2026-11-06): "Fri 6 Nov". A day has no zone, so this is the same wherever the business is. */
export const dayOf = (day: string): string => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
