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
