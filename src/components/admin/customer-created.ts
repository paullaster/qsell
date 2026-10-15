'use client';

import { useEffect } from 'react';
import type { Choice } from '@/lib/payment-options';

export const CUSTOMER_CREATED = 'qsell:customer-created';

/** Tells the screen underneath a "new customer" window which customer was just made. */
export function publishCustomerCreated(choice: Choice): void {
  window.dispatchEvent(new CustomEvent<Choice>(CUSTOMER_CREATED, { detail: choice }));
}

/** Calls `onCreated` with each customer made in the "new customer" window while this screen is open. */
export function useCustomerCreated(onCreated: (choice: Choice) => void): void {
  useEffect(() => {
    const listener = (event: Event) => {
      if (event instanceof CustomEvent) onCreated(event.detail as Choice);
    };
    window.addEventListener(CUSTOMER_CREATED, listener);
    return () => window.removeEventListener(CUSTOMER_CREATED, listener);
  }, [onCreated]);
}
