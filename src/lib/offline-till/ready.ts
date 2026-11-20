'use client';

import { offlineSnapshotAction } from '@/server/domains/selling/offline/offline-actions';
import { deviceId, setMeta, type TillMeta } from './store';

/** The page the till sells from with no connection, and the file that keeps it (and what it needs to start) in the browser. */
export const OFFLINE_TILL_PATH = '/admin/cash-sales/offline';
const WORKER = '/offline-till-sw.js';

/**
 * Makes this browser ready to keep selling if the connection drops: keeps the page and its files, and what the till may sell and the
 * shift's key. Safe to call again at any time (the cashier's page does, every few minutes while online). Returns why it could not, in words.
 */
export async function prepareOfflineTill(): Promise<{ ok: true; savedAt: string } | { ok: false; error: string }> {
  try {
    if (!('serviceWorker' in navigator)) return { ok: false, error: 'This browser cannot keep the till for offline use.' };
    const snap = await offlineSnapshotAction();
    if (!snap.ok) return snap;
    const savedAt = new Date().toISOString();
    const meta: TillMeta = { snapshot: snap.data, savedAt, deviceId: await deviceId(), counter: 0 };
    await setMeta('snapshot', meta.snapshot);
    await setMeta('savedAt', savedAt);
    await navigator.serviceWorker.register(WORKER, { scope: '/admin/cash-sales' });
    await navigator.serviceWorker.ready;
    // Fetching the page through the worker is what keeps it.
    await fetch(OFFLINE_TILL_PATH, { credentials: 'same-origin', headers: { accept: 'text/html' } });
    return { ok: true, savedAt };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'The till could not be made ready for offline use.' };
  }
}
