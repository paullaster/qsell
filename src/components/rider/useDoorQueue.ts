'use client';

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { QueuedItem } from '@/lib/rider-queue';
import { allItems, onQueueChange } from './door-queue';

const subscribeOnline = (notify: () => void): (() => void) => {
  window.addEventListener('online', notify);
  window.addEventListener('offline', notify);
  return () => {
    window.removeEventListener('online', notify);
    window.removeEventListener('offline', notify);
  };
};

/** Whether the phone says it has signal. A phone can say yes and still fail to reach the shop; sending copes with that. */
export const useOnline = (): boolean =>
  useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );

/** What is kept on this phone, as it changes (here or in another tab). Empty until it has been read. */
export function useDoorQueue(): { items: QueuedItem[]; reload: () => void } {
  const [items, setItems] = useState<QueuedItem[]>([]);
  const reload = useCallback(() => {
    void allItems().then(setItems);
  }, []);
  useEffect(() => {
    reload();
    return onQueueChange(reload);
  }, [reload]);
  return { items, reload };
}
