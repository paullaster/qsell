import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { nextToSend, verdictOf, waitAfter, type QueuedItem, type Reply } from './rider-queue';

interface Sync {
  verdictOf: (r: Reply) => string;
  waitAfter: (n: number) => number;
  nextToSend: (items: QueuedItem[], riderId: string, now: number) => QueuedItem | null;
  sendWaiting: (deps: Deps) => Promise<{ sent: number; retry: boolean }>;
}
interface Deps {
  items: () => Promise<QueuedItem[]>;
  get: (id: string) => Promise<QueuedItem | undefined>;
  put: (i: QueuedItem) => Promise<unknown>;
  remove: (id: string) => Promise<unknown>;
  post: (path: string, body: Record<string, unknown>) => Promise<Reply>;
  upload: (b: Blob) => Promise<{ ok: boolean; photoId?: string; error?: string; network?: boolean }>;
  now: () => number;
}
const sync = createRequire(import.meta.url)('../../public/rider-sync.js') as Sync;

const item = (over: Partial<QueuedItem>): QueuedItem => ({ id: 'k1', riderId: 'r1', kind: 'deliver', runId: 'run1', deliveryId: 'd1', label: 'DLV-1', payload: { receivedBy: 'Jo' }, photo: null, photoId: null, createdAt: '2026-11-04T10:00:00Z', state: 'waiting', message: null, tries: 0, nextAt: 0, ...over });

function world(start: QueuedItem[], reply: (body: Record<string, unknown>) => Reply | Error) {
  const store = new Map(start.map((i) => [i.id, i]));
  const posted: Record<string, unknown>[] = [];
  const deps: Deps = {
    items: () => Promise.resolve([...store.values()]),
    get: (id) => Promise.resolve(store.get(id)),
    put: (i) => Promise.resolve(store.set(i.id, i)),
    remove: (id) => Promise.resolve(store.delete(id)),
    now: () => 1_000,
    post: (_path, body) => {
      posted.push(body);
      const r = reply(body);
      return r instanceof Error ? Promise.reject(r) : Promise.resolve(r);
    },
    upload: () => Promise.resolve({ ok: true, photoId: 'p1' }),
  };
  return { store, posted, deps };
}

describe('the worker follows the same rules as the app', () => {
  it('reads every kind of answer the way the app does', () => {
    const replies: Reply[] = [{ ok: true }, { ok: false, error: 'x', forbidden: true }, { ok: false, error: 'x', code: 'NOT_FOUND' }, { ok: false, error: 'x', code: 'CONFLICT' }, { ok: false, error: 'x', code: 'BAD_INPUT' }, { ok: false, error: 'x', code: 'NOT_ALLOWED' }, { ok: false, error: 'x' }, { ok: false, error: 'x', code: 'OTHER' }];
    for (const r of replies) expect(sync.verdictOf(r)).toBe(verdictOf(r));
  });

  it('waits the same time after each failed try', () => {
    for (const n of [0, 1, 2, 3, 6, 20]) expect(sync.waitAfter(n)).toBe(waitAfter(n));
  });

  it('picks the same next item', () => {
    const sets = [
      [item({ id: 'b', createdAt: '2026-11-04T10:05:00Z' }), item({ id: 'a' }), item({ id: 'x', riderId: 'r2' })],
      [item({ id: 'f', kind: 'finish', deliveryId: null, createdAt: '2026-11-04T09:00:00Z' }), item({ id: 's' })],
      [item({ id: 'a', nextAt: 5000 }), item({ id: 'c', state: 'rejected' })],
      [item({ id: 'f', kind: 'finish', deliveryId: null })],
    ];
    for (const items of sets) for (const rider of ['r1', 'r2']) for (const now of [0, 1000, 9000]) expect(sync.nextToSend(items, rider, now)?.id ?? null).toBe(nextToSend(items, rider, now)?.id ?? null);
  });
});

describe('sending from the worker', () => {
  it('sends stops before the finish, oldest first, and removes what the shop took', async () => {
    const w = world([item({ id: 'f', kind: 'finish', deliveryId: null, createdAt: '2026-11-04T09:00:00Z' }), item({ id: 'b', createdAt: '2026-11-04T10:05:00Z' }), item({ id: 'a' })], () => ({ ok: true }));
    const out = await sync.sendWaiting(w.deps);
    expect(w.posted.map((p) => p.id)).toEqual(['a', 'b', 'f']);
    expect(out).toEqual({ sent: 3, retry: false });
    expect(w.store.size).toBe(0);
  });

  it('keeps a refusal with its reason and carries on with the rest', async () => {
    const w = world([item({ id: 'a' }), item({ id: 'b', deliveryId: 'd2', createdAt: '2026-11-04T10:05:00Z' })], (b) => (b.id === 'a' ? { ok: false, error: 'Not yours.', code: 'NOT_FOUND' } : { ok: true }));
    const out = await sync.sendWaiting(w.deps);
    expect(out.sent).toBe(1);
    expect(w.store.get('a')).toMatchObject({ state: 'rejected', message: 'Not yours.' });
    expect(w.store.has('b')).toBe(false);
  });

  it('stops and asks to be tried again when the shop cannot be reached, waiting longer each time', async () => {
    const w = world([item({ id: 'a' }), item({ id: 'b', createdAt: '2026-11-04T10:05:00Z' })], () => new Error('offline'));
    const out = await sync.sendWaiting(w.deps);
    expect(out).toEqual({ sent: 0, retry: true });
    expect(w.posted).toHaveLength(1);
    expect(w.store.get('a')).toMatchObject({ tries: 1, nextAt: 1_000 + 5_000, state: 'waiting' });
  });

  it('leaves a signed-out rider\'s items alone, still sends another rider\'s, and does not ask for a retry', async () => {
    const w = world([item({ id: 'a' }), item({ id: 'x', riderId: 'r2', createdAt: '2026-11-04T10:05:00Z' })], (b) => (b.riderId === 'r1' ? { ok: false, error: 'Sign in', forbidden: true } : { ok: true }));
    const out = await sync.sendWaiting(w.deps);
    expect(out).toEqual({ sent: 1, retry: false });
    expect(w.store.get('a')).toMatchObject({ state: 'waiting', tries: 0 });
  });

  it('uploads the photo once, names it in the send, and does not send the item if the photo fails', async () => {
    const withPhoto = item({ id: 'a', photo: new Blob(['x'], { type: 'image/jpeg' }) });
    const ok = world([withPhoto], () => ({ ok: true }));
    await sync.sendWaiting(ok.deps);
    expect(ok.posted[0]).toMatchObject({ photoId: 'p1' });
    const bad = world([withPhoto], () => ({ ok: true }));
    bad.deps.upload = () => Promise.resolve({ ok: false, error: 'Too large.', network: false });
    const out = await sync.sendWaiting(bad.deps);
    expect(out.retry).toBe(true);
    expect(bad.posted).toHaveLength(0);
    expect(bad.store.get('a')).toMatchObject({ message: 'Too large.', tries: 1 });
  });

  it('does not bring back an item the app sent while the worker was busy', async () => {
    const w = world([item({ id: 'a' })], () => new Error('offline'));
    const get = w.deps.get;
    w.deps.get = async (id) => {
      w.store.delete(id);
      return await get(id);
    };
    await sync.sendWaiting(w.deps);
    expect(w.store.size).toBe(0);
  });
});
