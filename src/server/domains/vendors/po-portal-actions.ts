'use server';

import { getContainer } from '@/server/di/container';
import { portal } from './portal-runner';
import { ProfileError } from './profile-service';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (value: unknown): string => {
  if (typeof value !== 'string' || !UUID.test(value)) throw new ProfileError('NOT_FOUND', 'That order does not exist.');
  return value;
};

export async function vendorOrdersAction(before: { sentAt: string; id: string } | null = null) {
  return await portal('po_list', async (me) => {
    const cursor = before !== null && typeof before === 'object' && UUID.test(before.id) && before.sentAt.length <= 40 ? { sentAt: before.sentAt, id: before.id } : null;
    return await getContainer().poPortal.list(me.vendorId, cursor);
  });
}

export async function vendorOrderAction(poId: string) {
  return await portal('po_view', async (me) => await getContainer().poPortal.load(me, idOf(poId)));
}

export async function confirmOrderAction(poId: string) {
  return await portal('po_confirm', async (me) => {
    await getContainer().poPortal.confirm(me, idOf(poId), me.companyId);
  });
}
