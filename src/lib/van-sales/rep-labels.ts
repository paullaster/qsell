/**
 * The short words the rep's phone shows: which day, how far along. Pure; the date it is "today" is passed in.
 */
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

const dayNumber = (date: string): number => Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 86_400_000);

/** Today, Tomorrow or Yesterday, otherwise the weekday and date: "Mon 30 Nov". */
export function dayLabel(date: string, today: string): string {
  const gap = dayNumber(date) - dayNumber(today);
  if (gap === 0) return 'Today';
  if (gap === 1) return 'Tomorrow';
  if (gap === -1) return 'Yesterday';
  const d = new Date(`${date}T00:00:00Z`);
  return `${WEEKDAYS[d.getUTCDay()] ?? ''} ${String(d.getUTCDate())} ${MONTHS[d.getUTCMonth()] ?? ''}`;
}

/** How far along the visits are: "3 of 7 visits", "No visits" and "All 7 visits done". */
export function progressWords(done: number, total: number): string {
  if (total === 0) return 'No visits';
  if (done >= total) return `All ${String(total)} ${total === 1 ? 'visit' : 'visits'} done`;
  return `${String(done)} of ${String(total)} ${total === 1 ? 'visit' : 'visits'}`;
}

/** The share of the visits finished, 0 to 100, for a progress bar. */
export const progressPercent = (done: number, total: number): number => (total <= 0 ? 0 : Math.min(100, Math.round((done / total) * 100)));
