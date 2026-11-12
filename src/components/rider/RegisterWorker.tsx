'use client';

import { useEffect } from 'react';

/** Puts the rider app's service worker in place, so the screens opened with signal can be opened again without it. */
export function RegisterWorker() {
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.register('/rider-sw.js', { scope: '/rider' }).catch(() => undefined);
  }, []);
  return null;
}

/** Asks the worker to keep a run's screen ahead of time (the runs on the home screen), so it opens without signal later. */
export function keepRunScreen(runId: string): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready.then((r) => r.active?.postMessage({ type: 'keep', url: `/rider/runs/${runId}` })).catch(() => undefined);
}

/**
 * Asks the browser to send what is saved on this phone as soon as it has signal, even if the app has been closed by then. A browser
 * without background sync (or a phone that will not keep the request) simply does not; the app still sends while it is open.
 */
export function askForBackgroundSend(): void {
  if (!('serviceWorker' in navigator)) return;
  void navigator.serviceWorker.ready
    .then(async (r) => {
      const sync = (r as ServiceWorkerRegistration & { sync?: { register: (tag: string) => Promise<void> } }).sync;
      await sync?.register('rider-door');
    })
    .catch(() => undefined);
}
