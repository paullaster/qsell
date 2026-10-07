import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

export type ActorType = 'user' | 'system' | 'job' | 'integration';

export interface Actor {
  type: ActorType;
  /** User id, job name, or integration name. */
  id: string | null;
}

export interface KernelContext {
  /** Ties together everything done for one request, job or integration call. */
  correlationId: string;
  actor: Actor;
}

const storage = new AsyncLocalStorage<KernelContext>();

export const SYSTEM_ACTOR: Actor = { type: 'system', id: null };

/** Runs `fn` with a context; everything it calls (including awaited work) can read it. */
export function runWithContext<T>(
  ctx: Partial<KernelContext> & { actor: Actor },
  fn: () => Promise<T>,
): Promise<T> {
  return storage.run({ correlationId: ctx.correlationId ?? randomUUID(), actor: ctx.actor }, fn);
}

/** The ambient context, or a fresh system one when called outside any request. */
export function currentContext(): KernelContext {
  return storage.getStore() ?? { correlationId: randomUUID(), actor: SYSTEM_ACTOR };
}
