'use client';

import type { OfflineSnapshot } from '@/server/domains/selling/offline/offline-sale-service';
import type { OutboxEntry } from './outbox';

/**
 * The till's memory in the browser (IndexedDB): what it may sell (kept while online), the shift's key, its own number, and the outbox of
 * sales waiting to be sent. Every read and write is wrapped: a browser that blocks storage simply cannot sell offline, and says so.
 */
const NAME = 'qsell-offline-till';
const VERSION = 1;

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('This browser cannot keep sales on the till.'));
      return;
    }
    const request = indexedDB.open(NAME, VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta');
      if (!db.objectStoreNames.contains('outbox')) db.createObjectStore('outbox', { keyPath: 'key' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('The till\'s memory could not be opened.'));
  });
}

function run<T>(store: 'meta' | 'outbox', mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = work(tx.objectStore(store));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('The till\'s memory could not be used.'));
        tx.oncomplete = () => db.close();
      }),
  );
}

export interface TillMeta {
  snapshot: OfflineSnapshot | null;
  savedAt: string | null;
  deviceId: string;
  counter: number;
}

export const getMeta = <T>(key: string): Promise<T | undefined> => run<T | undefined>('meta', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
export const setMeta = (key: string, value: unknown): Promise<IDBValidKey> => run('meta', 'readwrite', (s) => s.put(value, key));
export const outboxPut = (entry: OutboxEntry): Promise<IDBValidKey> => run('outbox', 'readwrite', (s) => s.put(entry));
export const outboxDelete = (key: string): Promise<undefined> => run('outbox', 'readwrite', (s) => s.delete(key));
const inOrder = (a: OutboxEntry, b: OutboxEntry): number => {
  const byTime = a.sale.deviceTime.localeCompare(b.sale.deviceTime);
  return byTime === 0 ? a.sale.deviceRef.localeCompare(b.sale.deviceRef) : byTime;
};
export const outboxAll = async (): Promise<OutboxEntry[]> => (await run<OutboxEntry[]>('outbox', 'readonly', (s) => s.getAll() as IDBRequest<OutboxEntry[]>)).sort(inOrder);

/** How many sales are waiting on this till (for the Shifts screen, which must not close a shift with sales still to send). Zero when the browser has none to keep. */
export async function waitingOnThisTill(): Promise<number> {
  try {
    return (await outboxAll()).length;
  } catch {
    return 0;
  }
}

/** This till's short name, made once and kept (it prefixes the reference on every slip). */
export async function deviceId(): Promise<string> {
  const known = await getMeta<string>('deviceId');
  if (known !== undefined) return known;
  const made = Array.from(crypto.getRandomValues(new Uint8Array(2)), (b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  await setMeta('deviceId', made);
  return made;
}

/** The next number for a slip on this till. */
export async function nextCounter(): Promise<number> {
  const next = ((await getMeta<number>('counter')) ?? 0) + 1;
  await setMeta('counter', next);
  return next;
}
