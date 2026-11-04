'use client';

import { useEffect, useState } from 'react';
import { trackedDeliveryAction, type CustomerTracking } from '@/server/domains/delivery/tracking-actions';

export type TrackedDeliveryState = { phase: 'loading' } | { phase: 'none' } | { phase: 'error'; error: string } | { phase: 'ok'; tracking: CustomerTracking };

/** An order's deliveries from the customer's side, for someone who knows the order number and the contact it was placed with. */
export function useTrackedDelivery(orderNumber: string, contact: string): TrackedDeliveryState {
  const [state, setState] = useState<TrackedDeliveryState>({ phase: 'loading' });
  useEffect(() => {
    let live = true;
    void trackedDeliveryAction({ orderNumber, contact }).then((r) => {
      if (!live) return;
      if (!r.ok) setState({ phase: 'error', error: r.error });
      else setState(r.data === null ? { phase: 'none' } : { phase: 'ok', tracking: r.data });
    });
    return () => {
      live = false;
    };
  }, [orderNumber, contact]);
  return state;
}
