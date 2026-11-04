'use server';

import { requireUser } from '@/server/domains/access-control/guard';
import { AccessDeniedError } from '@/server/domains/access-control/engine';
import { getContainer } from '@/server/di/container';
import { injectedDelay } from '@/server/domains/finance/action-runner';
import { DeliveryError } from './errors';
import type { RiderSelf } from './riders';

export type RiderResult<T> = { ok: true; data: T } | { ok: false; error: string; code?: string; forbidden?: true };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Every rider-app action goes through here. The person is the signed-in account; the rider is the row the server finds for them
 * (riding, on a kind the company still uses). Nothing about who the rider is, or which company, comes from the phone. A person who
 * is not a rider is told so, in the same words whatever the reason, so the app reveals nothing about other accounts.
 */
async function runRider<T>(fn: (self: RiderSelf) => Promise<T>): Promise<RiderResult<T>> {
  try {
    await injectedDelay();
    const userId = await requireUser();
    const self = await getContainer().deliveryRiders.forUser(userId);
    if (self === null) return { ok: false, error: 'This account is not set up to ride. Ask the shop to add you as a rider.', forbidden: true };
    return { ok: true, data: await fn(self) };
  } catch (error: unknown) {
    if (error instanceof AccessDeniedError) return { ok: false, error: 'Sign in to use the rider app.', forbidden: true };
    if (error instanceof DeliveryError) return { ok: false, error: error.message, code: error.code };
    console.error('[rider-app]', error);
    return { ok: false, error: 'Something went wrong. Please try again.' };
  }
}

/** Who is using the app, and their runs still to do and the few most recently finished. */
export async function myRunsAction() {
  return await runRider(async (self) => ({ self: { name: self.name, kind: self.kind }, ...(await getContainer().riderRuns.mine(self)) }));
}

/** One of the rider's own runs with its stops. Another rider's run answers "not found". */
export async function myRunAction(runId: unknown) {
  return await runRider(async (self) => {
    const found = typeof runId === 'string' && UUID.test(runId) ? await getContainer().riderRuns.one(self, runId) : null;
    if (found === null) throw new DeliveryError('That run could not be found.', 'NOT_FOUND');
    return found;
  });
}
