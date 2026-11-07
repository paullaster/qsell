'use server';

import { canPermission } from '@/server/domains/access-control/guard';
import { getContainer } from '@/server/di/container';
import type { VisitStatus } from '@/lib/visit';
import { idOf, objectOf, runDelivery } from './action-support';
import { DeliveryError, type DeliveryErrorCode } from './errors';
import type { DocRefusal, DocResult } from './documents';
import type { VisitActor } from './visits';

const CODE_FOR: Record<DocRefusal, DeliveryErrorCode> = { not_found: 'NOT_FOUND', bad_input: 'BAD_INPUT', not_allowed: 'NOT_ALLOWED', conflict: 'CONFLICT', order_not_ready: 'NOT_ALLOWED', nothing_left: 'BAD_INPUT', wrong_method: 'NOT_ALLOWED' };

function dataOf<T>(result: DocResult<T>): T {
  if (result.ok) return result.data;
  throw new DeliveryError(result.message, CODE_FOR[result.reason]);
}

const PATHS = ['/admin/delivery/visits'];

/** The scheduler (visits:manage) acts on every visit; anyone else with visits:work only on the ones they are on the crew of. */
async function actorOf(ctx: { companyId: string; userId: string }): Promise<VisitActor> {
  return { companyId: ctx.companyId, userId: ctx.userId, crewOnly: !(await canPermission('visits:manage')) };
}

const STATUSES: readonly string[] = ['live', 'scheduled', 'crew_assigned', 'on_site', 'completed', 'signed_off', 'cancelled'];

/** Visits by their time, soonest first. */
export async function visitsPageAction(raw?: unknown) {
  return await runDelivery('visits:work', async (ctx) => {
    const i = objectOf(raw);
    const status = typeof i.status === 'string' && STATUSES.includes(i.status) ? (i.status as VisitStatus | 'live') : 'live';
    return await getContainer().orderVisits.list(await actorOf(ctx), { status, cursor: typeof i.cursor === 'string' ? i.cursor : null });
  });
}

export async function bookVisitAction(raw: unknown) {
  return await runDelivery('visits:manage', async (ctx) => dataOf(await getContainer().orderVisits.book(await actorOf(ctx), objectOf(raw))), PATHS);
}

export async function assignCrewAction(raw: unknown) {
  return await runDelivery('visits:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().orderVisits.assign(await actorOf(ctx), idOf(i.id, 'visit'), { crewIds: i.crewIds, expectedVersion: i.expectedVersion }));
  }, PATHS);
}

export async function moveVisitAction(raw: unknown) {
  return await runDelivery('visits:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().orderVisits.reschedule(await actorOf(ctx), idOf(i.id, 'visit'), { startsAt: i.startsAt, endsAt: i.endsAt, reason: i.reason, expectedVersion: i.expectedVersion }));
  }, PATHS);
}

export async function cancelVisitAction(raw: unknown) {
  return await runDelivery('visits:manage', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().orderVisits.cancel(await actorOf(ctx), idOf(i.id, 'visit'), { reason: i.reason, expectedVersion: i.expectedVersion }));
  }, PATHS);
}

export async function startVisitAction(raw: unknown) {
  return await runDelivery('visits:work', async (ctx) => dataOf(await getContainer().orderVisits.start(await actorOf(ctx), idOf(objectOf(raw).id, 'visit'))), PATHS);
}

export async function tickVisitItemAction(raw: unknown) {
  return await runDelivery('visits:work', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().orderVisits.tick(await actorOf(ctx), idOf(i.id, 'visit'), idOf(i.itemId, 'item'), i.done === true));
  }, PATHS);
}

export async function completeVisitAction(raw: unknown) {
  return await runDelivery('visits:work', async (ctx) => dataOf(await getContainer().orderVisits.complete(await actorOf(ctx), idOf(objectOf(raw).id, 'visit'))), PATHS);
}

export async function signOffVisitAction(raw: unknown) {
  return await runDelivery('visits:work', async (ctx) => {
    const i = objectOf(raw);
    return dataOf(await getContainer().orderVisits.signOff(await actorOf(ctx), idOf(i.id, 'visit'), { name: i.name }));
  }, PATHS);
}
