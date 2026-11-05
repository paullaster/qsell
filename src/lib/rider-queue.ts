/**
 * The rider's queue of what was done at the door while the phone had no signal. Pure rules: what an item is, how the server's answer is
 * read, which item goes next and when, and what the screen should show while an item waits. The phone's storage and the sending are
 * elsewhere. Every item carries the key its try was given when the form opened, so sending it twice is one try on the server.
 */

import { firstNonZero } from '@/lib/values';

export type QueuedKind = 'deliver' | 'fail' | 'finish';

export interface QueuedItem {
  /** The try's own key (for a finish, a key made for it): unique, and the item's identity. */
  id: string;
  /** Whose item it is; another rider signing in on the same phone neither sees nor sends it. */
  riderId: string;
  kind: QueuedKind;
  runId: string;
  /** Not for a finish. */
  deliveryId: string | null;
  /** What the rider calls it, for the lines that say what is waiting: the delivery's number, or the run's. */
  label: string;
  /** What the action is given, apart from the photo: who received it, the code, the reason, the note, the place and the phone's time at the door. */
  payload: Record<string, unknown>;
  /** A photo taken at the door and not yet sent. */
  photo: Blob | null;
  /** The photo's id once it has been sent, so a retry does not send it again. */
  photoId: string | null;
  createdAt: string;
  /** `waiting` to be sent, `rejected` once the shop has said no (it stays to be read and dismissed). */
  state: 'waiting' | 'rejected';
  message: string | null;
  /** How many times it has been tried and could not be sent, for the wait before the next. */
  tries: number;
  nextAt: number;
}

/** What the server said, as the app receives it. */
export type Reply = { ok: true } | { ok: false; error: string; code?: string; forbidden?: true };

export type Verdict = 'done' | 'retry' | 'rejected' | 'sign_in';

/**
 * How to read an answer. Sent (or sent before: the server answers a repeat of the same try as the first) is done. Not signed in is not a
 * failure of the item: it waits for the rider to sign in. A refusal with a reason (not found, not allowed, bad input, conflict) is the
 * shop's decision and will not change by asking again. Anything else (the server fell over) is tried again later.
 */
export function verdictOf(reply: Reply): Verdict {
  if (reply.ok) return 'done';
  if (reply.forbidden === true) return 'sign_in';
  if (reply.code === 'NOT_FOUND' || reply.code === 'NOT_ALLOWED' || reply.code === 'BAD_INPUT' || reply.code === 'CONFLICT') return 'rejected';
  return 'retry';
}

const BASE_WAIT_MS = 5_000;
const MAX_WAIT_MS = 5 * 60_000;

/** Waits 5 s, 10 s, 20 s ... up to 5 minutes after each failed send. */
export const waitAfter = (tries: number): number => Math.min(MAX_WAIT_MS, BASE_WAIT_MS * 2 ** Math.max(0, tries - 1));

/** The items of this rider still to send, oldest first. */
export function waitingFor(items: readonly QueuedItem[], riderId: string): QueuedItem[] {
  return items.filter((i) => i.riderId === riderId && i.state === 'waiting').sort((a, b) => firstNonZero(a.createdAt.localeCompare(b.createdAt), a.id.localeCompare(b.id)));
}

/** The next item to send: the oldest whose wait is over. Stops go before the finish of their run, however they were made. */
export function nextToSend(items: readonly QueuedItem[], riderId: string, now: number): QueuedItem | null {
  const waiting = waitingFor(items, riderId);
  const due = waiting.filter((i) => i.nextAt <= now);
  const stops = due.filter((i) => i.kind !== 'finish');
  const first = stops[0] ?? due.find((i) => !waiting.some((w) => w.kind !== 'finish' && w.runId === i.runId));
  return first ?? null;
}

/** The stops of a run that have something waiting, so the screen can say so instead of offering the buttons again. */
export const pendingStops = (items: readonly QueuedItem[], riderId: string, runId: string): Set<string> =>
  new Set(waitingFor(items, riderId).filter((i) => i.runId === runId && i.deliveryId !== null).map((i) => i.deliveryId ?? ''));

export const hasFinishWaiting = (items: readonly QueuedItem[], riderId: string, runId: string): boolean => waitingFor(items, riderId).some((i) => i.kind === 'finish' && i.runId === runId);

/**
 * Whether the rider may finish the run from what this phone knows: it is on the road and every stop still to do has been answered here
 * (and is waiting to be sent). The shop checks again when it arrives.
 */
export function canFinishHere(run: { status: string; stops: readonly { deliveryId: string; open: boolean }[] }, pending: ReadonlySet<string>): boolean {
  if (run.status !== 'started') return false;
  const open = run.stops.filter((s) => s.open);
  return open.length > 0 && open.every((s) => pending.has(s.deliveryId));
}

/** The line on the screen about what is waiting. Null when nothing is. */
export function queueWords(waiting: number, rejected: number, online: boolean): string | null {
  const parts: string[] = [];
  if (waiting > 0) parts.push(`${String(waiting)} ${waiting === 1 ? 'thing is' : 'things are'} saved on this phone and ${online ? 'being sent' : 'will be sent when you have signal'}.`);
  if (rejected > 0) parts.push(`${String(rejected)} could not be saved by the shop. Read why below.`);
  return parts.length === 0 ? null : parts.join(' ');
}
