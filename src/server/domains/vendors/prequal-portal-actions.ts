'use server';

import { getContainer } from '@/server/di/container';
import { businessDate } from '@/server/kernel/numbering/business-date';
import { portal } from './portal-runner';
import { ProfileError } from './profile-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProfileError('NOT_FOUND', 'That record does not exist.');
  return value;
};

/** The categories the vendor can apply for and every application it has. */
export async function prequalOverviewAction() {
  return await portal('prequal_overview', async (me) => {
    const container = getContainer();
    const [open, mine] = await Promise.all([container.prequal.open(me.companyId, me.vendorId, businessDate()), container.prequal.mine(me.vendorId)]);
    return {
      canApply: open.canApply && (me.portalRole === 'owner' || me.portalRole === 'sales'),
      notActive: !open.canApply,
      categories: open.categories,
      mine: mine.map((m) => ({ ...m, submittedAt: m.submittedAt?.toISOString() ?? null })),
    };
  });
}

/** Starts an application for each chosen category (several may be chosen at once). */
export async function applyAction(categoryIds: unknown) {
  return await portal('prequal_apply', async (me) => {
    const list = Array.isArray(categoryIds) ? categoryIds.slice(0, 20).map(idOf) : [];
    return await getContainer().prequal.apply(me, me.companyId, list, businessDate());
  });
}

export async function prequalEntryAction(entryId: string) {
  return await portal('prequal_entry', async (me) => await getContainer().prequal.load(me, idOf(entryId)));
}

export async function saveAnswersAction(entryId: string, answers: unknown) {
  return await portal('prequal_answers', async (me) => {
    const raw = typeof answers === 'object' && answers !== null ? (answers as Record<string, unknown>) : {};
    const clean = Object.fromEntries(Object.entries(raw).filter(([k, v]) => UUID.test(k) && typeof v === 'string').map(([k, v]) => [k, String(v).slice(0, 2100)]));
    await getContainer().prequal.saveAnswers(me, idOf(entryId), clean);
  });
}

export async function submitEntryAction(entryId: string) {
  return await portal('prequal_submit', async (me) => {
    await getContainer().prequal.submit(me, idOf(entryId));
  });
}

export async function withdrawEntryAction(entryId: string) {
  return await portal('prequal_withdraw', async (me) => {
    await getContainer().prequal.withdraw(me, idOf(entryId));
  });
}
