'use server';

import { getContainer } from '@/server/di/container';
import { portal } from './portal-runner';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What we have paid this vendor: the vendor comes from the session, never from the request. */
export async function vendorPaymentsAction(before: { stamp: string; id: string } | null = null) {
  return await portal('payments_list', async (me) => {
    const cursor = before !== null && typeof before === 'object' && UUID.test(before.id) && before.stamp.length <= 40 ? { stamp: before.stamp, id: before.id } : null;
    return await getContainer().vendorPayments.remittances(me.vendorId, cursor);
  });
}
