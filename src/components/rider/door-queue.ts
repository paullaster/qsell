import type { QueuedItem } from '@/lib/rider-queue';

/**
 * Where the rider's unsent work is kept on the phone: IndexedDB (a photo is a file, which it holds as it is). Every call is safe to
 * make where there is no storage (a private window, a blocked store): it answers "nothing" and the app works as it did, online only.
 */
const DATABASE = 'rider-door';
const STORE = 'items';
const CHANNEL = 'rider-door-changed';

const listeners = new Set<() => void>();
let channel: BroadcastChannel | null = null;

function announce(): void {
  for (const l of listeners) l();
  try {
    channel ??= new BroadcastChannel(CHANNEL);
    channel.postMessage('changed');
  } catch {
    /* another tab is told only where the browser can */
  }
}

/** Calls back whenever the queue changes, here or in another tab of the app. Returns the way to stop. */
export function onQueueChange(listener: () => void): () => void {
  listeners.add(listener);
  let other: BroadcastChannel | null = null;
  try {
    other = new BroadcastChannel(CHANNEL);
    other.onmessage = () => listener();
  } catch {
    other = null;
  }
  return () => {
    listeners.delete(listener);
    other?.close();
  };
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('no storage'));
      return;
    }
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('storage failed'));
  });
}

async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = work(db.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('storage failed'));
    });
  } finally {
    db.close();
  }
}

export async function allItems(): Promise<QueuedItem[]> {
  try {
    return await run<QueuedItem[]>('readonly', (s) => s.getAll() as IDBRequest<QueuedItem[]>);
  } catch {
    return [];
  }
}

/** Saves (or replaces) an item. False when the phone would not keep it, so the caller can say so. */
export async function putItem(item: QueuedItem): Promise<boolean> {
  try {
    await run('readwrite', (s) => s.put(item));
    announce();
    return true;
  } catch {
    return false;
  }
}

export async function removeItem(id: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(id));
  } catch {
    /* nothing to remove */
  }
  announce();
}
