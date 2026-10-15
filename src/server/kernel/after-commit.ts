import type { DrizzleDb } from '@/server/db/drizzle/client';

type Tx = Parameters<Parameters<DrizzleDb['transaction']>[0]>[0];

const pending = new WeakMap<object, (() => void | Promise<void>)[]>();

/**
 * Work that must only happen once the surrounding transaction has committed (sending a signed
 * document to KRA, broadcasting a realtime event). Code deep inside a transaction calls this; the
 * code that opened the transaction runs `withAfterCommit`. If the transaction rolls back, the
 * queued work is dropped, so nothing is announced or sent for something that never happened.
 */
export function afterCommit(tx: object, work: () => void | Promise<void>): void {
  const list = pending.get(tx) ?? [];
  list.push(work);
  pending.set(tx, list);
}

/** Runs `fn` in a transaction, then the work queued with `afterCommit` (errors are logged, never thrown). */
export async function withAfterCommit<T>(db: DrizzleDb, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const captured: { tx: Tx | null } = { tx: null };
  const result = await db.transaction(async (tx) => {
    captured.tx = tx;
    return await fn(tx);
  });
  const work = captured.tx === null ? [] : (pending.get(captured.tx) ?? []);
  if (captured.tx !== null) pending.delete(captured.tx);
  for (const job of work) {
    try {
      await job();
    } catch (error) {
      console.error('[after-commit] work failed', error);
    }
  }
  return result;
}
