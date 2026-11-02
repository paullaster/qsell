'use server';

import { getContainer } from '@/server/di/container';
import { objectOf, runDelivery } from './action-support';

const PATHS = ['/admin/delivery/invoicing'];

const view = (b: Awaited<ReturnType<ReturnType<typeof getContainer>['deliveryBilling']['get']>>) => ({ ...b, updatedAt: b.updatedAt?.toISOString() ?? null });

/** How delivery is invoiced now, the item that stands for it and any tax that does not agree with it. */
export async function deliveryBillingPageAction() {
  return await runDelivery('deliveries:read', async (ctx) => view(await getContainer().deliveryBilling.get(ctx.companyId)));
}

export async function saveDeliveryBillingAction(raw: unknown) {
  return await runDelivery(
    'deliveries:manage',
    async (ctx) => {
      const i = objectOf(raw);
      return view(await getContainer().deliveryBilling.save(ctx.companyId, ctx.userId, { mode: i.mode, serviceProductId: i.serviceProductId, expectedVersion: i.expectedVersion, reason: i.reason }));
    },
    PATHS,
  );
}
