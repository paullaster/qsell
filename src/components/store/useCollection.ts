'use client';

import { useCallback, useEffect, useState } from 'react';
import { trackedCollectionAction, type CustomerCollection } from '@/server/domains/delivery/collection-actions';

export type CollectionState = { phase: 'loading' } | { phase: 'none' } | { phase: 'error'; error: string } | { phase: 'ok'; collection: CustomerCollection };

/**
 * An order's collection from the customer's side: where to collect and the code to show, for someone who knows the order number and
 * the contact it was placed with. `none` when the order is not one for collection (it is delivered), which is the common case.
 */
export function useCollection(orderNumber: string, contact: string): { state: CollectionState; refresh: () => void } {
  const [state, setState] = useState<CollectionState>({ phase: 'loading' });
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let live = true;
    void trackedCollectionAction({ orderNumber, contact }).then((r) => {
      if (!live) return;
      if (!r.ok) setState({ phase: 'error', error: r.error });
      else setState(r.data === null ? { phase: 'none' } : { phase: 'ok', collection: r.data });
    });
    return () => {
      live = false;
    };
  }, [orderNumber, contact, tick]);

  const refresh = useCallback(() => setTick((n) => n + 1), []);
  return { state, refresh };
}
