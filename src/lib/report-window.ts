/** The last `days` days up to and including `now`, as YYYY-MM-DD dates. Pure: the clock is passed in. */
export function lastDays(now: Date, days: number): { from: string; to: string } {
  const DAY_MS = 86_400_000;
  return { from: new Date(now.getTime() - days * DAY_MS).toISOString().slice(0, 10), to: now.toISOString().slice(0, 10) };
}
