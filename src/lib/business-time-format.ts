/** How a stored instant is written for people, in the business's time zone (never the server's or the browser's). Pure: the zone is always given. */

/** "18 Oct 2026, 17:00" style: the date and the time of an instant. */
export const whenIn = (iso: string, timeZone: string): string => new Date(iso).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone });

/** The date written out for a plain day (2026-11-06): "Fri 6 Nov". A day has no zone, so this is the same wherever the business is. */
export const dayOf = (day: string): string => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
