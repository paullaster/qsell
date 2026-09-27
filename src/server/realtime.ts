/**
 * PostgreSQL-backed pub/sub for Server-Sent Events across app and worker processes.
 *
 * This is intentionally the ONLY thing left in memory. It carries no durable
 * data — every consumer of these events treats them as a "something changed,
 * go re-read the database" hint, so a lost event costs a refresh, never data.
 *
 * The in-process listener set only fans database notifications out to SSE
 * clients connected to this process; PostgreSQL carries events between them.
 */
import postgres from 'postgres';

type Listener = (event: string, data: unknown) => void;

type RealtimeState = {
  listeners: Set<Listener>;
  sql?: ReturnType<typeof postgres>;
  listening?: boolean;
};

const globalForRealtime = globalThis as unknown as { omniRealtimeV2?: RealtimeState };

const state = (globalForRealtime.omniRealtimeV2 ??= { listeners: new Set<Listener>() });
const CHANNEL = 'omni_realtime';

function getRealtimeSql() {
  if (!state.sql) {
    // max: 2 leaves one connection available for NOTIFY while LISTEN holds one.
    state.sql = postgres(
      process.env.DATABASE_URL ?? 'postgres://qsell:qsell@127.0.0.1:5432/qsell',
      { max: 2, idle_timeout: 20, connect_timeout: 10 },
    );
  }
  return state.sql;
}

function ensureRealtimeListener() {
  if (state.listening) return;
  state.listening = true;
  void getRealtimeSql()
    .listen(CHANNEL, (payload) => {
      try {
        const message = JSON.parse(payload) as { event: string; data: unknown };
        deliverRealtime(message.event, message.data);
      } catch (error) {
        console.error('[realtime] invalid PostgreSQL notification', error);
      }
    })
    .catch((error: unknown) => {
      state.listening = false;
      console.error('[realtime] PostgreSQL listener failed', error);
      setTimeout(ensureRealtimeListener, 1_000).unref?.();
    });
}

function deliverRealtime(event: string, data: unknown) {
  for (const send of state.listeners) {
    try {
      send(event, data);
    } catch {
      state.listeners.delete(send);
    }
  }
}

/** Register an SSE client. Returns the unsubscribe function. */
export function subscribeRealtime(listener: Listener): () => void {
  state.listeners.add(listener);
  ensureRealtimeListener();
  return () => {
    state.listeners.delete(listener);
  };
}

/**
 * Fan an event out to every connected client. Fire-and-forget: a wedged or
 * closed client must never fail the database write that triggered the event.
 */
export async function broadcastRealtime(event: string, data: unknown): Promise<void> {
  try {
    await getRealtimeSql().notify(CHANNEL, JSON.stringify({ event, data }));
  } catch (error) {
    console.error('[realtime] PostgreSQL notification failed', error);
    deliverRealtime(event, data);
  }
}
