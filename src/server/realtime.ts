/**
 * In-process pub/sub for Server-Sent Events.
 *
 * This is intentionally the ONLY thing left in memory. It carries no durable
 * data — every consumer of these events treats them as a "something changed,
 * go re-read the database" hint, so a lost event costs a refresh, never data.
 *
 * Extracted from the old `PostgresStore`, which mixed this transport with the
 * catalog Maps that have now moved to Postgres.
 */
type Listener = (event: string, data: unknown) => void;

const globalForRealtime = globalThis as unknown as { omniRealtime?: Set<Listener> };

const listeners: Set<Listener> = (globalForRealtime.omniRealtime ??= new Set<Listener>());

/** Register an SSE client. Returns the unsubscribe function. */
export function subscribeRealtime(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fan an event out to every connected client. Fire-and-forget: a wedged or
 * closed client must never fail the database write that triggered the event.
 */
export function broadcastRealtime(event: string, data: unknown): void {
  for (const send of listeners) {
    try {
      send(event, data);
    } catch {
      listeners.delete(send);
    }
  }
}
