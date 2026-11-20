/**
 * The offline till's own bookkeeping (docs/architecture/offline-selling.md), apart from the browser: what a pending sale is, the
 * reference the customer is given, how much room the shift has left, and what a sale's answer from the server means for the outbox.
 * Pure: the clock, the counter and the answer are passed in.
 */
import type { IngestResult } from '@/server/domains/selling/offline/offline-sale-service';
import { offlineRoom, type OfflineLimits, type SignedOfflineSale } from '@/server/domains/selling/offline/offline-rules';

/** What the till keeps for each sale until the server has taken it in. */
export interface OutboxEntry {
  key: string;
  sale: SignedOfflineSale;
  /** `pending`: to be sent. `attention`: the server could not take it in and said why (it is kept here and, when the server holds it, there). */
  state: 'pending' | 'attention';
  reason: string | null;
  tries: number;
  /** For the slip it was given and for the list of what was sent: the lines' names and the change. */
  words: { lines: { name: string; quantity: number; unitPrice: number }[]; change: number };
}

/** The reference printed on the slip: this till's name and its own running number. */
export const deviceRefOf = (deviceId: string, counter: number): string => `OFF-${deviceId}-${String(counter).padStart(4, '0')}`;

/** What is waiting to be sent, in the order it was rung up. */
export const pendingTotal = (entries: readonly OutboxEntry[]): number => Math.round(entries.filter((e) => e.state === 'pending').reduce((sum, e) => sum + e.sale.total * 100, 0)) / 100;

/** Whether the shift may still sell this much offline, from what the server already counted and what is waiting here. */
export function mayStillSell(input: { limits: OfflineLimits; soldSoFar: number; entries: readonly OutboxEntry[]; total: number }): { ok: true } | { ok: false; error: string } {
  const room = offlineRoom(input.limits, input.soldSoFar + pendingTotal(input.entries));
  return input.total <= room + 1e-9 ? { ok: true } : { ok: false, error: `This shift can sell at most ${room.toLocaleString('en-KE', { minimumFractionDigits: 2 })} more with no connection (the company's limit). Wait for the connection, or ask a supervisor.` };
}

export type AfterSend =
  | { kind: 'done'; words: string }
  | { kind: 'held'; words: string }
  | { kind: 'keep'; entry: OutboxEntry };

/**
 * What a send's answer means for the outbox. A sale the server took in is done. A sale the server could not make but kept (parked, refused)
 * is no longer only here, so it leaves the outbox with a message to the cashier. A sale the server could not answer (no connection, an
 * error) stays and is tried again; one it cannot ever accept from this till (switched off, not this person's shift) stays with the reason.
 */
export function afterSend(entry: OutboxEntry, answer: IngestResult | { thrown: true }): AfterSend {
  if ('thrown' in answer) return { kind: 'keep', entry: { ...entry, tries: entry.tries + 1 } };
  if (!answer.ok) {
    const never = /switched off|not from one of your shifts|could not be read|no valid|not signed|not what the lines/i.test(answer.error);
    return { kind: 'keep', entry: { ...entry, tries: entry.tries + 1, state: never ? 'attention' : 'pending', reason: answer.error } };
  }
  if (answer.status === 'accepted' || answer.status === 'needs_review') {
    const receipt = answer.receiptNumber ?? answer.orderNumber;
    return { kind: 'done', words: `${entry.sale.deviceRef} is now receipt ${receipt}${answer.status === 'needs_review' ? ' (a supervisor will look at a difference)' : ''}.` };
  }
  const reason = 'reason' in answer ? answer.reason : '';
  return { kind: 'held', words: `${entry.sale.deviceRef} could not be made into a sale yet: ${reason} A supervisor can see it under Cash Sales, Offline sales to look at.` };
}
