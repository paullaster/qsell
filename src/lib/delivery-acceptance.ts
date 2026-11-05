import { roundQty } from '@/lib/decimal';

/**
 * Partial acceptance at the door: the customer takes some of what is on the delivery and not the rest. These are the rules only: what
 * the rider may enter, what counts as a delivery, and which reasons are allowed for what was not taken. The database and screens follow them.
 */

export const NOT_ACCEPTED_REASONS = [
  { code: 'refused', words: 'The customer did not want it' },
  { code: 'damaged', words: 'It was damaged' },
  { code: 'wrong_item', words: 'It was not what the customer ordered' },
  { code: 'other', words: 'Another reason (say which)' },
] as const;
export type NotAcceptedReason = (typeof NOT_ACCEPTED_REASONS)[number]['code'];
export const isNotAcceptedReason = (value: unknown): value is NotAcceptedReason => typeof value === 'string' && NOT_ACCEPTED_REASONS.some((r) => r.code === value);

export interface CarriedLine {
  productId: string;
  /** What the delivery carries: picked, or planned if never counted. */
  quantity: number;
}

export interface AcceptedLine {
  productId: string;
  quantity: number;
  /** Why some of it was not taken; required when quantity is less than carried. */
  reasonCode?: unknown;
  note?: unknown;
}

export interface NotAccepted {
  productId: string;
  quantity: number;
  reasonCode: NotAcceptedReason;
  note: string | null;
}

export type Acceptance = { ok: true; accepted: CarriedLine[]; notAccepted: NotAccepted[]; whole: boolean } | { ok: false; error: string };

/**
 * What the customer took against what the delivery carries. Nothing given means everything was taken. Every line must be answered, no
 * line can have more taken than carried, a shortfall needs a reason (and words for "another reason"), and taking nothing at all is not a
 * delivery (the rider records that it could not be delivered instead).
 */
export function checkAcceptance(carried: readonly CarriedLine[], given: readonly AcceptedLine[] | null): Acceptance {
  const live = carried.filter((c) => c.quantity > 0);
  if (given === null || given.length === 0) return { ok: true, accepted: live.map((c) => ({ ...c })), notAccepted: [], whole: true };
  const said = new Map<string, AcceptedLine>();
  for (const g of given) {
    if (said.has(g.productId)) return { ok: false, error: 'Each product can be answered once.' };
    said.set(g.productId, g);
  }
  for (const id of said.keys()) if (!live.some((c) => c.productId === id)) return { ok: false, error: 'Something was answered that is not on this delivery.' };
  const accepted: CarriedLine[] = [];
  const notAccepted: NotAccepted[] = [];
  for (const c of live) {
    const g = said.get(c.productId);
    if (g === undefined) return { ok: false, error: 'Say how much of every product the customer took, even if it is none.' };
    if (!Number.isFinite(g.quantity) || g.quantity < 0) return { ok: false, error: 'A quantity taken cannot be less than nothing.' };
    const taken = roundQty(g.quantity);
    if (taken > c.quantity) return { ok: false, error: 'The customer cannot have taken more than the delivery carries.' };
    accepted.push({ productId: c.productId, quantity: taken });
    if (taken < c.quantity) {
      if (!isNotAcceptedReason(g.reasonCode)) return { ok: false, error: 'Say why some of it was not taken.' };
      const note = typeof g.note === 'string' && g.note.trim() !== '' ? g.note.trim().slice(0, 300) : null;
      if (g.reasonCode === 'other' && note === null) return { ok: false, error: 'Say what happened to what was not taken.' };
      notAccepted.push({ productId: c.productId, quantity: roundQty(c.quantity - taken), reasonCode: g.reasonCode, note });
    }
  }
  if (accepted.every((a) => a.quantity === 0)) return { ok: false, error: 'The customer took nothing. Record that it could not be delivered instead.' };
  return { ok: true, accepted, notAccepted, whole: notAccepted.length === 0 };
}

/** The days a delivery can be put off to: tomorrow up to two weeks ahead, as `YYYY-MM-DD` in the business's own days. */
export const RESCHEDULE_DAYS_AHEAD = 14;

export type Reschedule = { ok: true; date: string } | { ok: false; error: string };

const addDays = (day: string, n: number): string => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};

/** A new day for a delivery, from the business's today: not today or before, and not more than two weeks away. */
export function checkRescheduleDay(value: unknown, today: string): Reschedule {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(new Date(`${value}T00:00:00Z`).getTime()) || addDays(value, 0) !== value) return { ok: false, error: 'Choose a day.' };
  if (value <= today) return { ok: false, error: 'Choose a day after today.' };
  if (value > addDays(today, RESCHEDULE_DAYS_AHEAD)) return { ok: false, error: `Choose a day within the next ${String(RESCHEDULE_DAYS_AHEAD)} days.` };
  return { ok: true, date: value };
}
