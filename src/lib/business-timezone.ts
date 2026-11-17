/**
 * The business's time zone: what is a valid choice, how a list of zones from an outside source is made safe, and how an offset is
 * written. Pure. The zone itself is a company setting kept in the database (Settings, Business time zone), not a constant.
 */

/** The zone a company starts with, and the one used before a company's own is known (a new database, a test). Never the live value. */
export const BUILT_IN_TIME_ZONE = 'Africa/Nairobi';

/** The shape of an IANA zone name: Region/City, a deeper Region/Area/City, or a single name such as UTC. */
const SHAPE = /^[A-Za-z0-9_+-]+(\/[A-Za-z0-9_+-]+)*$/;

/** Whether the runtime knows this zone. Everything that turns an instant into a day or an hour goes through the same runtime, so this is the test that matters. */
export function isValidTimeZone(value: unknown): boolean {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || !SHAPE.test(value)) return false;
  // A bare offset or abbreviation (EST, GMT+3) is not a place: only Region/City names and UTC are choices.
  if (!value.includes('/') && value !== 'UTC') return false;
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export type TimeZoneInput = { ok: true; timeZone: string } | { ok: false; error: string };

/** A zone as typed or chosen: trimmed, and refused in words when it is not one the system can use. */
export function readTimeZone(raw: unknown): TimeZoneInput {
  const value = typeof raw === 'string' ? raw.trim() : '';
  if (value === '') return { ok: false, error: 'Choose the business time zone.' };
  if (!isValidTimeZone(value)) return { ok: false, error: `“${value.slice(0, 64)}” is not a time zone this system knows. Choose one from the list, such as Africa/Nairobi.` };
  return { ok: true, timeZone: value };
}

/**
 * The zones in an answer from an outside list: only text that is a zone the runtime knows, each once, in order. Anything else in the
 * answer (a wrong shape, a name we cannot use, an overlong string) is dropped rather than trusted. Null when nothing usable is in it.
 */
export function zonesFromList(answer: unknown): string[] | null {
  if (!Array.isArray(answer)) return null;
  const seen = new Set<string>();
  const items: unknown[] = answer;
  for (const item of items) if (typeof item === 'string' && isValidTimeZone(item)) seen.add(item);
  return seen.size === 0 ? null : [...seen].sort((a, b) => a.localeCompare(b));
}

/** The zones the runtime itself knows, for when the outside list cannot be reached. */
export function runtimeZones(): string[] {
  const supported = (Intl as unknown as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
  const own = typeof supported === 'function' ? supported.call(Intl, 'timeZone') : [];
  return [...new Set(['UTC', ...own.filter(isValidTimeZone)])].sort((a, b) => a.localeCompare(b));
}

/** How far a zone is from UTC at an instant, written as UTC+03:00 (so a picker can show it beside the name). Empty when it cannot be worked out. */
export function offsetLabel(timeZone: string, at: Date): string {
  try {
    const part = new Intl.DateTimeFormat('en-GB', { timeZone, timeZoneName: 'longOffset' }).formatToParts(at).find((p) => p.type === 'timeZoneName')?.value ?? '';
    if (part === 'GMT') return 'UTC+00:00';
    return part.replace('GMT', 'UTC');
  } catch {
    return '';
  }
}

const PARTS = ['year', 'month', 'day', 'hour', 'minute', 'second'] as const;

/** How far ahead of UTC the zone's clock is at an instant, in milliseconds (positive east of Greenwich), daylight saving included. */
export function zoneOffsetMs(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(at);
  const n: Record<string, number> = {};
  for (const p of parts) if ((PARTS as readonly string[]).includes(p.type)) n[p.type] = Number(p.value);
  const asUtc = Date.UTC(n.year ?? 0, (n.month ?? 1) - 1, n.day ?? 1, n.hour ?? 0, n.minute ?? 0, n.second ?? 0);
  return asUtc - Math.floor(at.getTime() / 1000) * 1000;
}

/** The instant a wall-clock time on a calendar day is in the zone: 09:00 on 2026-11-05 in Africa/Nairobi is 06:00 UTC. */
export function instantInZone(day: string, time: string, timeZone: string): Date {
  const guess = new Date(`${day}T${time}:00Z`).getTime();
  // The offset can differ between the guess and the answer where the clocks change, so it is settled in two passes.
  const first = guess - zoneOffsetMs(new Date(guess), timeZone);
  return new Date(guess - zoneOffsetMs(new Date(first), timeZone));
}

/** The calendar day (YYYY-MM-DD) an instant falls on in the zone. */
export function dayInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}
