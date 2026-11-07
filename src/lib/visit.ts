/**
 * A booked visit: a crew goes to a customer's address at an agreed time for an order, for example to install or set up what was bought.
 * These are the rules only: the states and what may follow what, the window, the crew, the checklist and the sign-off. The database,
 * the order's timeline and the screens follow them.
 */

export const VISIT_STATUSES = ['scheduled', 'crew_assigned', 'on_site', 'completed', 'signed_off', 'cancelled'] as const;
export type VisitStatus = (typeof VISIT_STATUSES)[number];
export const isVisitStatus = (value: unknown): value is VisitStatus => typeof value === 'string' && (VISIT_STATUSES as readonly string[]).includes(value);

export const VISIT_ACTIONS = ['assign', 'reschedule', 'start', 'complete', 'sign_off', 'cancel'] as const;
export type VisitAction = (typeof VISIT_ACTIONS)[number];

/** From each state, what can be done and where it leads. Nothing leaves signed off or cancelled. */
const TRANSITIONS: Record<VisitStatus, Partial<Record<VisitAction, VisitStatus>>> = {
  scheduled: { assign: 'crew_assigned', reschedule: 'scheduled', cancel: 'cancelled' },
  // The crew can be changed, and the time moved, until the crew is on site.
  crew_assigned: { assign: 'crew_assigned', reschedule: 'crew_assigned', start: 'on_site', cancel: 'cancelled' },
  on_site: { complete: 'completed', cancel: 'cancelled' },
  completed: { sign_off: 'signed_off' },
  signed_off: {},
  cancelled: {},
};

export const nextVisitStatus = (status: VisitStatus, action: VisitAction): VisitStatus | null => TRANSITIONS[status][action] ?? null;
export const visitActionsFrom = (status: VisitStatus): VisitAction[] => Object.keys(TRANSITIONS[status]) as VisitAction[];
export const isVisitOver = (status: VisitStatus): boolean => visitActionsFrom(status).length === 0;

export const VISIT_STATUS_WORDS: Record<VisitStatus, string> = {
  scheduled: 'Booked',
  crew_assigned: 'Crew assigned',
  on_site: 'On site',
  completed: 'Done, waiting for sign-off',
  signed_off: 'Signed off',
  cancelled: 'Cancelled',
};

export const VISIT_ACTION_WORDS: Record<VisitAction, string> = {
  assign: 'Assign the crew',
  reschedule: 'Move the visit',
  start: 'Crew is on site',
  complete: 'Mark the work done',
  sign_off: 'Record the customer\'s sign-off',
  cancel: 'Cancel the visit',
};

export const MAX_VISIT_HOURS = 12;
export const MAX_CREW = 8;
export const MAX_CHECKLIST_ITEMS = 30;

export type Window = { ok: true; start: Date; end: Date } | { ok: false; error: string };

const toDate = (value: unknown): Date | null => {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** The time agreed with the customer: a start in the future and an end after it, within a working day. */
export function checkWindow(startRaw: unknown, endRaw: unknown, now: Date): Window {
  const start = toDate(startRaw);
  const end = toDate(endRaw);
  if (start === null || end === null) return { ok: false, error: 'Choose when the visit starts and when it ends.' };
  if (start.getTime() <= now.getTime()) return { ok: false, error: 'The visit must start in the future.' };
  if (end.getTime() <= start.getTime()) return { ok: false, error: 'The visit must end after it starts.' };
  if ((end.getTime() - start.getTime()) / 3_600_000 > MAX_VISIT_HOURS) return { ok: false, error: `A visit is at most ${String(MAX_VISIT_HOURS)} hours. Book a second visit for longer work.` };
  return { ok: true, start, end };
}

/** Who goes: at least one person, no one twice, not more than a crew can be. Returns the people in the order given. */
export function checkCrew(ids: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(ids) || ids.length === 0) return { ok: false, error: 'Choose at least one person to go.' };
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== 'string' || id === '') return { ok: false, error: 'One of the people chosen could not be read.' };
    if (out.includes(id)) return { ok: false, error: 'Each person can be on the crew once.' };
    out.push(id);
  }
  if (out.length > MAX_CREW) return { ok: false, error: `A crew is at most ${String(MAX_CREW)} people.` };
  return { ok: true, ids: out };
}

/** The items of a checklist, as typed: words, each short, not too many, none twice. */
export function checkItems(raw: unknown): { ok: true; items: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'A checklist needs at least one item.' };
  if (raw.length > MAX_CHECKLIST_ITEMS) return { ok: false, error: `A checklist has at most ${String(MAX_CHECKLIST_ITEMS)} items.` };
  const items: string[] = [];
  for (const r of raw) {
    const t = typeof r === 'string' ? r.trim() : '';
    if (t === '') return { ok: false, error: 'Each item needs words.' };
    if (t.length > 120) return { ok: false, error: 'An item is at most 120 characters.' };
    if (items.some((i) => i.toLowerCase() === t.toLowerCase())) return { ok: false, error: 'An item is on the checklist twice.' };
    items.push(t);
  }
  return { ok: true, items };
}

/** The work is done only when every item on the checklist is ticked. */
export function checklistProblem(items: readonly { done: boolean }[]): string | null {
  const left = items.filter((i) => !i.done).length;
  if (left === 0) return null;
  return `${String(left)} ${left === 1 ? 'item is' : 'items are'} not ticked on the checklist yet.`;
}

/** Who signed the work off for the customer: a name of at least two letters. */
export function signOffProblem(name: unknown): string | null {
  return typeof name === 'string' && name.trim().length >= 2 ? null : 'Say who signed the work off for the customer.';
}

export const reasonProblem = (reason: unknown, what: string): string | null => (typeof reason === 'string' && reason.trim().length >= 5 ? null : `Say why ${what}, in a few words.`);

/** The shop works in Nairobi (UTC+3, no daylight saving). A time typed in a date-time box is Nairobi time; the server keeps it as an instant. */
const NAIROBI_HOURS = 3;

/** "2026-11-07T08:00" typed in the box, to the instant it means. Null when it is not a time. */
export function fromNairobiInput(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const d = new Date(`${value}:00+0${String(NAIROBI_HOURS)}:00`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** An instant, to the text a date-time box shows for it in Nairobi. */
export function toNairobiInput(iso: string): string {
  return new Date(new Date(iso).getTime() + NAIROBI_HOURS * 3_600_000).toISOString().slice(0, 16);
}

/** The checklist as typed, one item to a line: blank lines are dropped. */
export const itemsFromLines = (lines: string): string[] => lines.split('\n').map((l) => l.trim()).filter((l) => l !== '');
