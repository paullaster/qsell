'use client';

import { useEffect } from 'react';

export const PRODUCT_UPDATED = 'qsell:product-updated';

/** Tells the screen underneath a product's edit window which product was just saved. */
export function publishProductUpdated(productId: string): void {
  window.dispatchEvent(new CustomEvent<string>(PRODUCT_UPDATED, { detail: productId }));
}

/** Calls `onUpdated` with the id of each product saved in the edit window while this screen is open. */
export function useProductUpdated(onUpdated: (productId: string) => void): void {
  useEffect(() => {
    const listener = (event: Event) => {
      if (event instanceof CustomEvent && typeof event.detail === 'string') onUpdated(event.detail);
    };
    window.addEventListener(PRODUCT_UPDATED, listener);
    return () => window.removeEventListener(PRODUCT_UPDATED, listener);
  }, [onUpdated]);
}
