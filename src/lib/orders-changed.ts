/** A small signal between screens: an order was changed in the window that opened over a list, so the list behind it reads its rows again. */

const EVENT = 'qsell:orders-changed';

export function announceOrdersChanged(): void {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(EVENT));
}

/** Calls `listener` whenever an order was changed; returns what stops listening. */
export function onOrdersChanged(listener: () => void): () => void {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}
