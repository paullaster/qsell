'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { queueWords, waitingFor, type QueuedItem } from '@/lib/rider-queue';
import { buttonClass } from '@/components/ui/screen-kit';
import { removeItem } from './door-queue';
import { askForBackgroundSend } from './RegisterWorker';
import { sendQueue } from './send-queue';
import { useDoorQueue, useOnline } from './useDoorQueue';

const RIDER_KEY = 'rider-app-rider';
const PAGES = 'rider-app-pages-v1';

/** Another rider on the same phone must not be shown the last rider's screens from the phone's copy. */
function forgetOtherRider(riderId: string): void {
  try {
    if (localStorage.getItem(RIDER_KEY) === riderId) return;
    localStorage.setItem(RIDER_KEY, riderId);
    void caches.delete(PAGES);
  } catch {
    /* no storage to compare with */
  }
}

/**
 * The top of a rider screen: whether the phone has signal, what is saved on it waiting to be sent, and what the shop refused (with
 * why, to be read and dismissed). It also sends: when the screen opens, when signal returns, and every so often while something
 * waits. A screen that shows a run keeps a copy of it on the phone for the next time there is no signal.
 */
export function OfflineBar({ riderId }: { riderId: string }) {
  const router = useRouter();
  const online = useOnline();
  const { items, reload } = useDoorQueue();
  const mine = items.filter((i) => i.riderId === riderId);
  const waiting = waitingFor(items, riderId).length;
  const rejected = mine.filter((i) => i.state === 'rejected');

  useEffect(() => forgetOtherRider(riderId), [riderId]);

  const flushRef = useRef<(ignoreWait?: boolean) => void>(() => undefined);
  useEffect(() => {
    let mounted = true;
    const flush = (ignoreWait = false): void => {
      void sendQueue(riderId, Date.now, ignoreWait).then((r) => {
        if (!mounted) return;
        reload();
        // What the shop took changes what the screen should say, so it is read again.
        if (r.sent > 0) router.refresh();
      });
    };
    flushRef.current = flush;
    const whenBack = (): void => flush(true);
    if (navigator.onLine) flush();
    const timer = setInterval(() => {
      if (navigator.onLine) flush();
    }, 20_000);
    window.addEventListener('online', whenBack);
    return () => {
      mounted = false;
      clearInterval(timer);
      window.removeEventListener('online', whenBack);
    };
  }, [riderId, reload, router]);

  // Something new was saved here: send it now if there is signal, and ask the browser to send it later if the app is closed first.
  useEffect(() => {
    if (waiting === 0) return;
    askForBackgroundSend();
    if (navigator.onLine) flushRef.current();
  }, [waiting]);

  // The worker sent something while this screen was open: read what the shop has now.
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return undefined;
    const heard = (event: MessageEvent): void => {
      const data = event.data as { type?: string; sent?: number } | null;
      if (data?.type !== 'door-sent') return;
      reload();
      if ((data.sent ?? 0) > 0) router.refresh();
    };
    navigator.serviceWorker.addEventListener('message', heard);
    return () => navigator.serviceWorker.removeEventListener('message', heard);
  }, [reload, router]);

  const line = queueWords(waiting, rejected.length, online);
  if (online && line === null) return null;
  return (
    <div className="space-y-2">
      {online ? null : (
        <p role="status" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
          You have no signal. What you do is saved on this phone and sent when the signal is back.
        </p>
      )}
      {line === null ? null : (
        <p role="status" className="rounded-xl border border-sky-300 bg-sky-50 p-3 text-sm text-sky-900">
          {line}
        </p>
      )}
      {rejected.length === 0 ? null : (
        <ul aria-label="Not saved by the shop" className="space-y-2">
          {rejected.map((i) => (
            <Rejected key={i.id} item={i} />
          ))}
        </ul>
      )}
    </div>
  );
}

function Rejected({ item }: { item: QueuedItem }) {
  return (
    <li role="alert" className="space-y-2 rounded-xl border border-red-300 bg-red-50 p-3 text-sm text-red-900">
      <p>
        <span className="font-semibold">{item.label}:</span> {item.message ?? 'The shop could not save this.'}
      </p>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={`${buttonClass} min-h-11`} onClick={() => void removeItem(item.id)}>
          Dismiss
        </button>
      </div>
    </li>
  );
}

