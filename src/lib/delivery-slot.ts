/**
 * Delivery slots: a window on certain weekdays at a branch, with room for so many deliveries and a time after which it can no longer be
 * booked. These are the rules only (dates are calendar days in Nairobi, UTC+3 with no daylight saving); the database and screens follow them.
 */

export const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const; // ISO: Monday is 1, Sunday is 7
export const WEEKDAY_WORDS: Record<number, string> = { 1: 'Monday', 2: 'Tuesday', 3: 'Wednesday', 4: 'Thursday', 5: 'Friday', 6: 'Saturday', 7: 'Sunday' };
export const MAX_DAYS_AHEAD = 60;
export const MAX_CAPACITY = 10_000;
export const MAX_CUTOFF_MINUTES = 7 * 24 * 60;
export const MAX_WEIGHT_KG = 1_000_000;
export const MAX_LEAD_MINUTES = 43_200;

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const isDay = (value: unknown): value is string => typeof value === 'string' && DATE.test(value) && !Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export const isTime = (value: unknown): value is string => typeof value === 'string' && TIME.test(value);

/** Monday is 1 and Sunday is 7, for a calendar day. */
export function weekdayOf(day: string): number {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

/** A calendar day some days after another. */
export function addDays(day: string, days: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The instant a Nairobi clock time on a calendar day is. */
export const instantOf = (day: string, time: string): Date => new Date(`${day}T${time}:00+03:00`);

/** Today's calendar day in Nairobi, from an instant. */
export const nairobiDay = (now: Date): string => new Date(now.getTime() + 3 * 3_600_000).toISOString().slice(0, 10);

export interface SlotRule {
  weekdays: number[];
  startsAt: string;
  endsAt: string;
  capacity: number;
  cutoffMinutes: number;
  /** The most the deliveries of a slot may weigh together in a day, in kg. Null: no limit by weight. */
  maxWeightKg: number | null;
  isActive: boolean;
}

export type SlotInput = { ok: true; value: Omit<SlotRule, 'isActive'> & { name: string } } | { ok: false; error: string };

/** A slot as typed: a name, the weekdays, the window, room for so many, and how long before it starts it stops being bookable. */
export function checkSlot(raw: { name?: unknown; weekdays?: unknown; startsAt?: unknown; endsAt?: unknown; capacity?: unknown; cutoffMinutes?: unknown; maxWeightKg?: unknown }): SlotInput {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 2 || name.length > 80) return { ok: false, error: 'Give the slot a name of two to eighty characters, for example "Morning".' };
  if (!Array.isArray(raw.weekdays) || raw.weekdays.length === 0) return { ok: false, error: 'Choose the days of the week this slot runs on.' };
  const weekdays: number[] = [];
  for (const w of raw.weekdays) {
    if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 7) return { ok: false, error: 'One of the days chosen could not be read.' };
    if (!weekdays.includes(w)) weekdays.push(w);
  }
  weekdays.sort((a, b) => a - b);
  if (!isTime(raw.startsAt) || !isTime(raw.endsAt)) return { ok: false, error: 'Give the start and end as times, for example 09:00.' };
  if (raw.endsAt <= raw.startsAt) return { ok: false, error: 'The slot must end after it starts.' };
  const capacity = raw.capacity;
  if (typeof capacity !== 'number' || !Number.isInteger(capacity) || capacity < 1 || capacity > MAX_CAPACITY) return { ok: false, error: `Capacity is a whole number from 1 to ${String(MAX_CAPACITY)}.` };
  const cutoff = raw.cutoffMinutes;
  if (typeof cutoff !== 'number' || !Number.isInteger(cutoff) || cutoff < 0 || cutoff > MAX_CUTOFF_MINUTES) return { ok: false, error: 'The cut-off is a whole number of minutes before the slot starts, up to a week.' };
  const weight = raw.maxWeightKg;
  let maxWeightKg: number | null = null;
  if (weight !== undefined && weight !== null && weight !== '') {
    if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0 || weight > MAX_WEIGHT_KG || Math.abs(weight * 100 - Math.round(weight * 100)) > 1e-6) return { ok: false, error: 'The weight limit is more than nothing, in kg to two decimals, or left empty for no limit.' };
    maxWeightKg = weight;
  }
  return { ok: true, value: { name, weekdays, startsAt: raw.startsAt, endsAt: raw.endsAt, capacity, cutoffMinutes: cutoff, maxWeightKg } };
}

export type Unavailable = 'stopped' | 'wrong_day' | 'closed' | 'past' | 'cut_off' | 'too_far' | 'full' | 'too_heavy' | 'too_soon';

export const UNAVAILABLE_WORDS: Record<Unavailable, string> = {
  stopped: 'This slot is no longer offered.',
  wrong_day: 'This slot does not run on that day.',
  closed: 'No deliveries are made that day.',
  past: 'That day has passed.',
  cut_off: 'It is too late to book this slot.',
  too_far: `Slots can be booked up to ${String(MAX_DAYS_AHEAD)} days ahead.`,
  full: 'This slot is full that day.',
  too_heavy: 'This slot cannot carry that much more that day.',
  too_soon: 'The goods will not be ready by then.',
};

/** Why a slot cannot be booked on a day right now, or null when it can. `taken` is how many deliveries already hold it that day. */
export function unavailable(rule: SlotRule, day: string, now: Date, taken: number, closedReason: string | null, extra: SlotExtra = {}): Unavailable | null {
  if (!rule.isActive) return 'stopped';
  if (!isDay(day) || !rule.weekdays.includes(weekdayOf(day))) return 'wrong_day';
  const today = nairobiDay(now);
  if (day < today) return 'past';
  if (day > addDays(today, MAX_DAYS_AHEAD)) return 'too_far';
  if (closedReason !== null) return 'closed';
  if (now.getTime() > instantOf(day, rule.startsAt).getTime() - rule.cutoffMinutes * 60_000) return 'cut_off';
  if (taken >= rule.capacity) return 'full';
  // The goods must be ready before the slot starts: its start is not before the earliest the delivery could be ready.
  if (extra.earliest !== undefined && extra.earliest !== null && instantOf(day, rule.startsAt).getTime() < extra.earliest.getTime()) return 'too_soon';
  if (rule.maxWeightKg !== null && extra.weight !== undefined && extra.weight.takenKg + extra.weight.kg > rule.maxWeightKg + 1e-9) return 'too_heavy';
  return null;
}

/** What is known of the delivery being booked, for the rules that depend on it: when it can be ready, and what it weighs against what the slot already carries. */
export interface SlotExtra {
  earliest?: Date | null;
  weight?: { kg: number; takenKg: number };
}

export interface Lead {
  /** In words: "Frozen fish", "Rural zone", "Standard handling". */
  label: string;
  minutes: number;
}

/** When the goods can first be ready: the order's time plus the longest of the lead times that apply. `by` says which one held it up. */
export function earliestReady(orderedAt: Date, leads: readonly Lead[]): { at: Date; by: string | null } {
  let longest: Lead | null = null;
  for (const l of leads) if (l.minutes > 0 && (longest === null || l.minutes > longest.minutes)) longest = l;
  return { at: new Date(orderedAt.getTime() + (longest?.minutes ?? 0) * 60_000), by: longest?.label ?? null };
}

/** A lead time in words: "45 minutes", "2 hours", "1 day 3 hours". */
export function leadWords(minutes: number): string {
  if (minutes < 60) return `${String(minutes)} ${minutes === 1 ? 'minute' : 'minutes'}`;
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const parts = [days > 0 ? `${String(days)} ${days === 1 ? 'day' : 'days'}` : '', hours > 0 ? `${String(hours)} ${hours === 1 ? 'hour' : 'hours'}` : '', rest > 0 ? `${String(rest)} min` : ''].filter((p) => p !== '');
  return parts.join(' ');
}

export type LeadInput = { ok: true; minutes: number; note: string | null } | { ok: false; error: string };

/** A lead time as typed: whole minutes, more than none, at most thirty days, with an optional note. */
export function checkLead(minutes: unknown, note: unknown): LeadInput {
  if (typeof minutes !== 'number' || !Number.isInteger(minutes) || minutes < 1 || minutes > MAX_LEAD_MINUTES) return { ok: false, error: 'Give the time in whole minutes, from 1 up to thirty days (43,200).' };
  const text = typeof note === 'string' && note.trim() !== '' ? note.trim() : null;
  if (text !== null && text.length > 200) return { ok: false, error: 'The note is at most 200 characters.' };
  return { ok: true, minutes, note: text };
}

/** The window a booked slot promises, as instants. Kept on the delivery so changing the slot later does not change what was promised. */
export function windowOf(day: string, rule: Pick<SlotRule, 'startsAt' | 'endsAt'>): { start: Date; end: Date } {
  return { start: instantOf(day, rule.startsAt), end: instantOf(day, rule.endsAt) };
}

/** The days to offer from a day on: some days, in order. */
export function daysFrom(day: string, count: number): string[] {
  const n = Math.max(1, Math.min(count, 14));
  return Array.from({ length: n }, (_, i) => addDays(day, i));
}

export function weekdaysWords(weekdays: readonly number[]): string {
  if (weekdays.length === 7) return 'Every day';
  const key = [...weekdays].sort((a, b) => a - b).join(',');
  if (key === '1,2,3,4,5') return 'Weekdays';
  if (key === '6,7') return 'Weekends';
  return [...weekdays].sort((a, b) => a - b).map((w) => (WEEKDAY_WORDS[w] ?? '').slice(0, 3)).join(', ');
}
