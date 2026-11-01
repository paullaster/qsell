/** Times of day written as HH:MM and counted as minutes after midnight. */

/** "HH:MM" from minutes after midnight; 1440 is the end of the day. */
export function clockText(minutes: number): string {
  const m = Math.max(0, Math.min(1440, minutes));
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/** Minutes after midnight from "HH:MM"; "24:00" is the end of the day. NaN when it is not a time. */
export function clockMinutes(text: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (m === null) return Number.NaN;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && minutes <= 1440 ? minutes : Number.NaN;
}
