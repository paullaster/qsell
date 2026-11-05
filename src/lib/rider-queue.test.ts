import { describe, expect, it } from 'vitest';
import { canFinishHere, hasFinishWaiting, nextToSend, pendingStops, queueWords, verdictOf, waitAfter, waitingFor, type QueuedItem } from './rider-queue';

const item = (over: Partial<QueuedItem>): QueuedItem => ({ id: 'k1', riderId: 'r1', kind: 'deliver', runId: 'run1', deliveryId: 'd1', label: 'DLV-1', payload: {}, photo: null, photoId: null, createdAt: '2026-11-04T10:00:00Z', state: 'waiting', message: null, tries: 0, nextAt: 0, ...over });

describe('reading the shop\'s answer', () => {
  it('is done when sent, signed out when not signed in, rejected for a decision, and retried for anything else', () => {
    expect(verdictOf({ ok: true })).toBe('done');
    expect(verdictOf({ ok: false, error: 'x', forbidden: true })).toBe('sign_in');
    for (const code of ['NOT_FOUND', 'NOT_ALLOWED', 'BAD_INPUT', 'CONFLICT']) expect(verdictOf({ ok: false, error: 'x', code })).toBe('rejected');
    expect(verdictOf({ ok: false, error: 'Something went wrong. Please try again.' })).toBe('retry');
    expect(verdictOf({ ok: false, error: 'x', code: 'DUPLICATE' })).toBe('retry');
  });
});

describe('waiting between tries', () => {
  it('doubles from five seconds up to five minutes', () => {
    expect([0, 1, 2, 3, 4, 10].map(waitAfter)).toEqual([5000, 5000, 10000, 20000, 40000, 300000]);
  });
});

describe('what goes next', () => {
  it('is the oldest due item of this rider only', () => {
    const items = [item({ id: 'b', createdAt: '2026-11-04T10:05:00Z' }), item({ id: 'a' }), item({ id: 'x', riderId: 'r2', createdAt: '2026-11-04T09:00:00Z' })];
    expect(waitingFor(items, 'r1').map((i) => i.id)).toEqual(['a', 'b']);
    expect(nextToSend(items, 'r1', 1)?.id).toBe('a');
  });

  it('skips an item whose wait is not over, and rejected ones', () => {
    const items = [item({ id: 'a', nextAt: 100 }), item({ id: 'b', createdAt: '2026-11-04T10:05:00Z' }), item({ id: 'c', state: 'rejected', createdAt: '2026-11-04T09:00:00Z' })];
    expect(nextToSend(items, 'r1', 50)?.id).toBe('b');
    expect(nextToSend([item({ nextAt: 100 })], 'r1', 50)).toBeNull();
  });

  it('sends the stops of a run before its finish, even if the finish was made first', () => {
    const items = [item({ id: 'f', kind: 'finish', deliveryId: null, createdAt: '2026-11-04T09:00:00Z' }), item({ id: 's' })];
    expect(nextToSend(items, 'r1', 1)?.id).toBe('s');
    expect(nextToSend(items.slice(0, 1), 'r1', 1)?.id).toBe('f');
  });

  it('holds the finish while a stop of its run is waiting for its turn', () => {
    const items = [item({ id: 'f', kind: 'finish', deliveryId: null }), item({ id: 's', nextAt: 500 })];
    expect(nextToSend(items, 'r1', 1)).toBeNull();
  });
});

describe('what the screen shows', () => {
  it('knows which stops are waiting and whether the run can be finished here', () => {
    const items = [item({ deliveryId: 'd1' }), item({ id: 'k2', deliveryId: 'd2', riderId: 'r2' }), item({ id: 'k3', kind: 'finish', deliveryId: null })];
    const pending = pendingStops(items, 'r1', 'run1');
    expect([...pending]).toEqual(['d1']);
    expect(hasFinishWaiting(items, 'r1', 'run1')).toBe(true);
    expect(hasFinishWaiting(items, 'r1', 'run2')).toBe(false);
    const run = { status: 'started', stops: [{ deliveryId: 'd1', open: true }, { deliveryId: 'd2', open: true }] };
    expect(canFinishHere(run, pending)).toBe(false);
    expect(canFinishHere(run, new Set(['d1', 'd2']))).toBe(true);
    expect(canFinishHere({ ...run, status: 'planned' }, new Set(['d1', 'd2']))).toBe(false);
    expect(canFinishHere({ status: 'started', stops: [{ deliveryId: 'd1', open: false }] }, new Set())).toBe(false);
  });

  it('says what is waiting and what the shop refused', () => {
    expect(queueWords(0, 0, true)).toBeNull();
    expect(queueWords(1, 0, false)).toBe('1 thing is saved on this phone and will be sent when you have signal.');
    expect(queueWords(2, 1, true)).toBe('2 things are saved on this phone and being sent. 1 could not be saved by the shop. Read why below.');
  });
});
